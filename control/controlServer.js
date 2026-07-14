/*
 * Backend for the local control dashboard.
 * Serves the OpenUI5 control panel, reads/writes .env settings, starts/stops
 * the algo server and ngrok tunnel, proxies health checks, and exposes recent
 * logs. This server is for local operations, not broker order placement.
 */
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = 4000;
const DHAN_SANDBOX_CLIENT_ID = "2601312809";

const envPath = path.join(__dirname, "..", ".env");
const axios = require("axios");
const { sendTelegram } = require("../src/services/telegramService");

let algoProcess = null;
let algoOutageAlertTimer = null;
let algoOutageAlerted = false;
let ngrokProcess = null;
let ngrokStarting = false;
let ngrokRestartTimer = null;
let ngrokRestartAttempts = 0;
let ngrokNextRestartAt = 0;
let ngrokOutageAlerted = false;
let ngrokUrl = "";
let keepAlgoRunning = process.env.IC_AUTO_MANAGE === "true";
let keepNgrokRunning = process.env.IC_AUTO_MANAGE === "true";
let shuttingDown = false;
const SELF_HEAL_DELAY_MS = 5000;
const NGROK_MAX_RESTART_DELAY_MS = 5 * 60 * 1000;
const PERSISTENT_OUTAGE_ALERT_MS = 60 * 1000;

function clearAlgoOutageAlert() {
  if (algoOutageAlertTimer) clearTimeout(algoOutageAlertTimer);
  algoOutageAlertTimer = null;
  algoOutageAlerted = false;
}

function scheduleAlgoOutageAlert() {
  if (algoOutageAlertTimer || algoOutageAlerted || shuttingDown) return;

  algoOutageAlertTimer = setTimeout(async () => {
    algoOutageAlertTimer = null;
    if (!keepAlgoRunning || shuttingDown || await isAlgoActuallyRunning()) return;
    algoOutageAlerted = true;
    sendTelegram("🚨 IC Algo Bot: algo server recovery failed for 60 seconds. Please open the dashboard and check System Readiness.");
  }, PERSISTENT_OUTAGE_ALERT_MS);
  algoOutageAlertTimer.unref();
}

function getNgrokRestartDelay() {
  return Math.min(
    SELF_HEAL_DELAY_MS * (2 ** Math.min(ngrokRestartAttempts, 6)),
    NGROK_MAX_RESTART_DELAY_MS,
  );
}

function scheduleNgrokRestart() {
  if (!keepNgrokRunning || shuttingDown || ngrokRestartTimer) return;

  const restartDelay = getNgrokRestartDelay();
  ngrokRestartAttempts += 1;
  ngrokNextRestartAt = Date.now() + restartDelay;
  appendLifecycleLog(
    `Ngrok restart attempt ${ngrokRestartAttempts} scheduled in ${Math.round(restartDelay / 1000)} seconds`,
    "warn",
  );

  // Brief ngrok exits are self-healed silently. Alert only after three failed
  // restart windows (about 35 seconds) have already elapsed.
  if (!ngrokOutageAlerted && ngrokRestartAttempts >= 4) {
    ngrokOutageAlerted = true;
    sendTelegram("🚨 IC Algo Bot: ngrok recovery is still failing. TradingView webhooks cannot reach the bot; please check System Readiness.");
  }

  ngrokRestartTimer = setTimeout(() => {
    ngrokRestartTimer = null;
    ngrokNextRestartAt = 0;
    if (!keepNgrokRunning || shuttingDown) return;
    axios.post(`http://localhost:${PORT}/api/start-ngrok`).catch((error) => {
      appendLifecycleLog(`Ngrok automatic restart failed: ${error.message}`, "error");
      scheduleNgrokRestart();
    });
  }, restartDelay);
  ngrokRestartTimer.unref();
}

function clearNgrokRestartState() {
  if (ngrokRestartTimer) clearTimeout(ngrokRestartTimer);
  ngrokRestartTimer = null;
  ngrokNextRestartAt = 0;
  ngrokRestartAttempts = 0;
  ngrokOutageAlerted = false;
}
const logPath = path.join(__dirname, "..", "logs", "app.log");
const instrumentMasterPath = path.join(__dirname, "..", "api-scrip-master.csv");
const tradingViewIndicatorPath = path.join(
  __dirname,
  "..",
  "tradingview",
  "nikhil-inside-candle-15min.pine",
);
const positionPath = path.join(__dirname, "..", "src", "data", "position.json");
const tradeStatePath = path.join(__dirname, "..", "src", "data", "tradeState.json");
const tradeHistoryPath = path.join(
  __dirname,
  "..",
  "src",
  "data",
  "tradeHistory.json",
);
const streakPlannerPath = path.join(
  __dirname,
  "..",
  "src",
  "data",
  "streakPlanner.json",
);
const STREAK_PLANNER_INTERVALS = ["1", "3", "5", "15", "30", "60"];
const STREAK_PLANNER_TRADE_COUNT = 50;
const STREAK_PLANNER_OUTCOMES = new Set([
  "",
  "-1",
  ...Array.from({ length: 10 }, (_, index) => String(index)),
]);

function getEmptyStreakPlanner() {
  return {
    updatedAt: null,
    rows: STREAK_PLANNER_INTERVALS.map((interval) => ({
      interval,
      trades: Array(STREAK_PLANNER_TRADE_COUNT).fill(""),
      updatedAt: Array(STREAK_PLANNER_TRADE_COUNT).fill(""),
    })),
  };
}

function normalizeStreakPlanner(payload) {
  const rowsByInterval = new Map(
    (Array.isArray(payload?.rows) ? payload.rows : []).map((row) => [
      String(row?.interval || ""),
      row,
    ]),
  );

  return {
    updatedAt: payload?.updatedAt || null,
    rows: STREAK_PLANNER_INTERVALS.map((interval) => {
      const source = rowsByInterval.get(interval);
      const trades = Array.isArray(source?.trades) ? source.trades : [];
      const updatedAt = Array.isArray(source?.updatedAt) ? source.updatedAt : [];
      const normalizedTrades = Array.from(
        { length: STREAK_PLANNER_TRADE_COUNT },
        (_, index) => {
          const rawOutcome = String(trades[index] ?? "").toUpperCase();
          const outcome = rawOutcome === "PROFIT"
            ? "1"
            : rawOutcome === "SL"
              ? "-1"
              : rawOutcome;
          return STREAK_PLANNER_OUTCOMES.has(outcome) ? outcome : "";
        },
      );

      return {
        interval,
        trades: normalizedTrades,
        updatedAt: Array.from({ length: STREAK_PLANNER_TRADE_COUNT }, (_, index) => {
          const value = String(updatedAt[index] || "");
          return normalizedTrades[index] && !Number.isNaN(new Date(value).getTime())
            ? value
            : "";
        }),
      };
    }),
  };
}

function readStreakPlanner() {
  return normalizeStreakPlanner(readJsonFile(streakPlannerPath) || getEmptyStreakPlanner());
}

function writeStreakPlanner(payload) {
  const planner = normalizeStreakPlanner(payload);
  const requestedUpdatedAt = String(payload?.updatedAt || "");
  planner.updatedAt = Number.isNaN(new Date(requestedUpdatedAt).getTime())
    ? new Date().toISOString()
    : requestedUpdatedAt;
  fs.mkdirSync(path.dirname(streakPlannerPath), { recursive: true });
  fs.writeFileSync(streakPlannerPath, `${JSON.stringify(planner, null, 2)}\n`);
  return planner;
}

const {
  UNDERLYING_PROFILES,
  getUnderlyingProfile,
} = require("../src/services/underlyingService");
const {
  applyDailyControlReset,
} = require("../src/services/dailyControlResetService");

// Accept JSON API requests and serve the dashboard assets from control/public.
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Parse .env into a simple key/value object for the dashboard model.
function readEnv() {
  const content = fs.readFileSync(envPath, "utf8");
  const result = {};

  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const [key, ...rest] = trimmed.split("=");
    result[key] = rest.join("=");
  });

  return result;
}

// Update existing .env keys while preserving comments and unrelated lines.
function writeEnv(updates) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  const updatedKeys = new Set();

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;

    const [key] = trimmed.split("=");

    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      updatedKeys.add(key);
      return `${key}=${updates[key]}`;
    }

    return line;
  });

  Object.entries(updates).forEach(([key, value]) => {
    if (!updatedKeys.has(key)) {
      updatedLines.push(`${key}=${value}`);
    }
  });

  fs.writeFileSync(envPath, updatedLines.join("\n"));
}

const PREMIUM_HUGE_CANDLE_FIELDS = [
  { activeKey: "PREMIUM_HUGE_CANDLE_1M", suffix: "1M", nifty: "6", banknifty: "10" },
  { activeKey: "PREMIUM_HUGE_CANDLE_3M", suffix: "3M", nifty: "12", banknifty: "15" },
  { activeKey: "PREMIUM_HUGE_CANDLE_5M", suffix: "5M", nifty: "15", banknifty: "20" },
  { activeKey: "PREMIUM_HUGE_CANDLE_15M", suffix: "15M", nifty: "25", banknifty: "40" },
  { activeKey: "PREMIUM_HUGE_CANDLE_30M", suffix: "30M", nifty: "40", banknifty: "70" },
];
const TRADINGVIEW_TIMEFRAME_FIELDS = [
  "ALLOW_TV_TIMEFRAME_1M",
  "ALLOW_TV_TIMEFRAME_3M",
  "ALLOW_TV_TIMEFRAME_5M",
  "ALLOW_TV_TIMEFRAME_15M",
  "ALLOW_TV_TIMEFRAME_30M",
  "ALLOW_TV_TIMEFRAME_60M",
];

function normalizeUnderlyingSymbol(symbol) {
  return String(symbol || "").toUpperCase() === "BANKNIFTY"
    ? "BANKNIFTY"
    : "NIFTY";
}

function premiumHugeCandleSymbolKey(symbol, suffix) {
  return normalizeUnderlyingSymbol(symbol) + "_PREMIUM_HUGE_CANDLE_" + suffix;
}

function getPremiumHugeCandleValue(env, symbol, field) {
  const normalized = normalizeUnderlyingSymbol(symbol);
  const symbolKey = premiumHugeCandleSymbolKey(normalized, field.suffix);
  const symbolValue = env[symbolKey];

  if (symbolValue !== undefined && symbolValue !== null && symbolValue !== "") {
    return String(symbolValue);
  }

  if (normalized === "NIFTY") {
    const activeValue = env[field.activeKey];

    if (activeValue !== undefined && activeValue !== null && activeValue !== "") {
      return String(activeValue);
    }
  }

  return normalized === "BANKNIFTY" ? field.banknifty : field.nifty;
}

function getPremiumHugeCandleResponseFields(env, symbol) {
  const normalized = normalizeUnderlyingSymbol(symbol);
  const response = {};

  PREMIUM_HUGE_CANDLE_FIELDS.forEach((field) => {
    const niftyKey = premiumHugeCandleSymbolKey("NIFTY", field.suffix);
    const bankniftyKey = premiumHugeCandleSymbolKey("BANKNIFTY", field.suffix);
    const niftyValue = getPremiumHugeCandleValue(env, "NIFTY", field);
    const bankniftyValue = getPremiumHugeCandleValue(env, "BANKNIFTY", field);

    response[niftyKey] = niftyValue;
    response[bankniftyKey] = bankniftyValue;
    response[field.activeKey] = normalized === "BANKNIFTY" ? bankniftyValue : niftyValue;
  });

  return response;
}

function syncPremiumHugeCandleUpdates(updates, previousEnv) {
  const normalized = normalizeUnderlyingSymbol(
    updates.UNDERLYING_SYMBOL || previousEnv.UNDERLYING_SYMBOL,
  );

  PREMIUM_HUGE_CANDLE_FIELDS.forEach((field) => {
    const activeProvided = Object.prototype.hasOwnProperty.call(
      updates,
      field.activeKey,
    );
    const selectedSymbolKey = premiumHugeCandleSymbolKey(
      normalized,
      field.suffix,
    );
    const selectedSymbolProvided = Object.prototype.hasOwnProperty.call(
      updates,
      selectedSymbolKey,
    );

    if (activeProvided && !selectedSymbolProvided) {
      updates[selectedSymbolKey] = updates[field.activeKey];
    }

    if (selectedSymbolProvided) {
      updates[field.activeKey] = updates[selectedSymbolKey];
    }
  });
}

function normalizePermissionPairUpdates(updates, previousEnv, first, second) {
  const hasFirstUpdate = Object.prototype.hasOwnProperty.call(updates, first);
  const hasSecondUpdate = Object.prototype.hasOwnProperty.call(updates, second);

  const firstEnabled = String(
    hasFirstUpdate ? updates[first] : previousEnv[first] || "true",
  ).toLowerCase() === "true";
  const secondEnabled = String(
    hasSecondUpdate ? updates[second] : previousEnv[second] || "true",
  ).toLowerCase() === "true";

  if (firstEnabled || secondEnabled) {
    return;
  }

  if (hasFirstUpdate && !hasSecondUpdate) {
    updates[second] = "true";
    return;
  }

  if (hasSecondUpdate && !hasFirstUpdate) {
    updates[first] = "true";
    return;
  }

  updates[second] = "true";
}

function normalizePairedPermissionUpdates(updates, previousEnv) {
  normalizePermissionPairUpdates(
    updates,
    previousEnv,
    "ALLOW_NIFTY_TV_SIGNALS",
    "ALLOW_BANKNIFTY_TV_SIGNALS",
  );
  normalizePermissionPairUpdates(updates, previousEnv, "ALLOW_BUY", "ALLOW_SELL");
}

function getTradingViewTimeframeResponseFields(env) {
  return Object.fromEntries(
    TRADINGVIEW_TIMEFRAME_FIELDS.map((key) => [
      key,
      key === "ALLOW_TV_TIMEFRAME_15M" ? "true" : env[key] || "false",
    ]),
  );
}

// Store token update time as readable IST while keeping it Date-parseable.
function getIstIsoString(date = new Date()) {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffsetMs);

  return `${istDate.toISOString().slice(0, 19)}+05:30`;
}

function appendLifecycleLog(message, level = "info") {
  const logDir = path.dirname(logPath);

  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    logPath,
    `${new Date().toISOString()} [${level.toUpperCase()}] LIFECYCLE ${message}\n`,
  );
}

function getManualSignalLogContext(payload = {}) {
  let env = {};

  try {
    env = readEnv();
  } catch (error) {
    env = {};
  }

  const paperTrade = String(env.PAPER_TRADE || "true").toLowerCase() === "true";
  const dhanEnv = String(env.DHAN_ENV || "LIVE").toUpperCase();
  const tradeMode = paperTrade ? "PAPER" : dhanEnv === "SANDBOX" ? "SANDBOX" : "LIVE";
  const parts = [
    `signal=${payload.signal || "unknown"}`,
    `symbol=${payload.symbol || "unknown"}`,
    `price=${payload.price ?? "unknown"}`,
    `interval=${payload.interval || payload.timeframe || "unknown"}`,
    `tradeMode=${tradeMode}`,
    `source=${payload.source || "MANUAL_SIGNAL"}`,
  ];

  return parts.join(" ");
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function roundMoney(value) {
  const number = Number(value);

  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function parseNseHolidayDate(value) {
  const monthIndexes = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  };
  const [day, month, year] = String(value || "").split("-");
  const date = new Date(
    Number(year),
    monthIndexes[month],
    Number(day),
    12,
    0,
    0,
  );

  return Number.isFinite(date.getTime()) ? date : null;
}

function cleanHtmlText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function matchRate(text, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escapedLabel}\\s*:\\s*([0-9.]+%?)`, "i"));

  return match?.[1] || "";
}

function getLatestRbiPolicyEvent(text) {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) =>
        /Monetary Policy Committee|Monetary Policy Statement|MPC/i.test(line),
      ) || ""
  );
}

function getRbiPolicyDateKeys(text) {
  const monthIndexes = {
    January: 0,
    February: 1,
    March: 2,
    April: 3,
    May: 4,
    June: 5,
    July: 6,
    August: 7,
    September: 8,
    October: 9,
    November: 10,
    December: 11,
  };
  const policyLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /Monetary Policy Committee|Monetary Policy Statement|MPC/i.test(line),
    );
  const dateKeys = new Set();

  policyLines.forEach((line) => {
    line.replace(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:\s+to\s+(\d{1,2}))?,\s*(\d{4})/gi,
      (match, month, startDay, endDay, year) => {
        const start = Number(startDay);
        const end = Number(endDay || startDay);

        for (let day = start; day <= end; day += 1) {
          dateKeys.add(
            getLocalDateKey(
              new Date(Number(year), monthIndexes[month], day, 12, 0, 0),
            ),
          );
        }

        return match;
      },
    );
  });

  return [...dateKeys].sort();
}

function getNextNiftyExpiry(profile = getUnderlyingProfile(readEnv()), now = new Date()) {
  const content = fs.readFileSync(instrumentMasterPath, "utf8");
  const [headerLine, ...lines] = content.split(/\r?\n/);
  const headers = headerLine.split(",");
  const indexes = {
    instrument: headers.indexOf("SEM_INSTRUMENT_NAME"),
    symbol: headers.indexOf("SEM_CUSTOM_SYMBOL"),
    expiry: headers.indexOf("SEM_EXPIRY_DATE"),
    optionType: headers.indexOf("SEM_OPTION_TYPE"),
  };
  const expiryDates = new Set();

  lines.forEach((line) => {
    if (!line) return;

    const columns = line.split(",");
    const expiryValue = columns[indexes.expiry];
    const dateKey = expiryValue?.slice(0, 10);

    if (
      columns[indexes.instrument] === "OPTIDX" &&
      columns[indexes.symbol]?.startsWith(profile.optionSymbolPrefix) &&
      ["CE", "PE"].includes(columns[indexes.optionType]) &&
      /^\d{4}-\d{2}-\d{2}$/.test(dateKey)
    ) {
      expiryDates.add(dateKey);
    }
  });

  const marketCloseToday = new Date(`${getLocalDateKey(now)}T15:30:00+05:30`);
  const eligibleDates = [...expiryDates]
    .filter((dateKey) => {
      const expiryMarketClose = new Date(`${dateKey}T15:30:00+05:30`);

      return dateKey === getLocalDateKey(now)
        ? now <= marketCloseToday
        : expiryMarketClose > now;
    })
    .sort();

  if (!eligibleDates.length) {
    return null;
  }

  const dateKey = eligibleDates[0];
  const expiryDate = new Date(`${dateKey}T12:00:00+05:30`);

  return {
    date: dateKey,
    day: expiryDate.toLocaleDateString("en-IN", { weekday: "long" }),
    isToday: dateKey === getLocalDateKey(now),
  };
}

function getNearestIndexExpiry(now = new Date()) {
  return Object.values(UNDERLYING_PROFILES)
    .map((profile) => ({
      profile,
      expiry: getNextNiftyExpiry(profile, now),
    }))
    .filter((item) => item.expiry?.date)
    .sort((a, b) => a.expiry.date.localeCompare(b.expiry.date))[0] || null;
}

async function getNextNseHoliday(now = new Date()) {
  const response = await axios.get(
    "https://www.nseindia.com/api/holiday-master?type=trading",
    {
      timeout: 7000,
      headers: {
        Accept: "application/json,text/plain,*/*",
        Referer: "https://www.nseindia.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      },
    },
  );
  const holidays = response.data?.FO || response.data?.CM || [];
  const today = new Date(`${getLocalDateKey(now)}T00:00:00+05:30`);
  const next = holidays
    .map((holiday) => ({
      ...holiday,
      date: parseNseHolidayDate(holiday.tradingDate),
    }))
    .filter((holiday) => holiday.date && holiday.date >= today)
    .sort((a, b) => a.date - b.date)[0];

  if (!next) {
    return null;
  }

  const dateKey = getLocalDateKey(next.date);

  return {
    date: dateKey,
    day: next.weekDay || next.date.toLocaleDateString("en-IN", { weekday: "long" }),
    description: next.description || "Trading holiday",
    segment: response.data?.FO ? "FO" : "CM",
    source: "NSE holiday calendar",
  };
}

async function getIndiaVix() {
  const response = await axios.get("https://www.nseindia.com/api/allIndices", {
    timeout: 7000,
    headers: {
      Accept: "application/json,text/plain,*/*",
      Referer: "https://www.nseindia.com/",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    },
  });
  const rows = Array.isArray(response.data?.data) ? response.data.data : [];
  const vix = rows.find((row) =>
    /india\s*vix/i.test(String(row?.index || row?.indexSymbol || "")),
  );
  const value = Number(vix?.last || vix?.lastPrice || vix?.lastPriceValue);
  const changePercent = Number(vix?.percentChange || vix?.perChange);

  if (!Number.isFinite(value)) {
    return null;
  }

  return {
    value,
    changePercent: Number.isFinite(changePercent) ? changePercent : null,
    source: "NSE allIndices",
  };
}

async function getRbiMarketIntel() {
  const response = await axios.get("https://www.rbi.org.in/", {
    timeout: 7000,
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    },
  });
  const text = cleanHtmlText(response.data);
  const asOf = text.match(/\(As at\s+([^)]+)\)/i)?.[1] || "";
  const source = text.match(/\(Source\s*:\s*([^)]+)\)/i)?.[1] || "";

  return {
    policyRates: {
      repo: matchRate(text, "Policy Repo Rate"),
      sdf: matchRate(text, "Standing Deposit Facility Rate"),
      msf: matchRate(text, "Marginal Standing Facility Rate"),
      bankRate: matchRate(text, "Bank Rate"),
      reverseRepo: matchRate(text, "Fixed Reverse Repo Rate"),
      crr: matchRate(text, "CRR"),
      slr: matchRate(text, "SLR"),
    },
    exchangeRates: {
      usdInr: matchRate(text, "INR / 1 USD"),
      gbpInr: matchRate(text, "INR / 1 GBP"),
      eurInr: matchRate(text, "INR / 1 EUR"),
      jpyInr: matchRate(text, "INR / 100 JPY"),
    },
    asOf,
    source,
    latestPolicyEvent: getLatestRbiPolicyEvent(text),
    policyDateKeys: getRbiPolicyDateKeys(text),
  };
}

async function getAlgoSnapshot() {
  let status = null;

  try {
    const response = await axios.get("http://localhost:3000/status", {
      timeout: 1500,
    });

    status = response.data;
  } catch (error) {
    status = null;
  }

  return {
    status,
    position: readJsonFile(positionPath),
    tradeState: readJsonFile(tradeStatePath),
    tradeHistory: readJsonFile(tradeHistoryPath),
  };
}

function getSnapshotEntryCount(snapshot) {
  return Number(snapshot?.tradeState?.entryCount || 0);
}

function getSnapshotTradeCount(snapshot) {
  const trades = snapshot?.tradeHistory?.trades;
  return Array.isArray(trades) ? trades.length : 0;
}

function didAlgoStateChange(before, after) {
  if (!after) {
    return false;
  }

  return (
    before?.position?.currentPosition !== after.position?.currentPosition ||
    getSnapshotEntryCount(before) !== getSnapshotEntryCount(after) ||
    getSnapshotTradeCount(before) !== getSnapshotTradeCount(after)
  );
}

function getIstDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).formatToParts(date);

  return {
    day: parts.find((part) => part.type === "day")?.value || "",
    month: parts.find((part) => part.type === "month")?.value || "",
    year: parts.find((part) => part.type === "year")?.value || "",
  };
}

function getIstDateKey(date) {
  const { day, month, year } = getIstDateParts(date);
  return `${year}-${month}-${day}`;
}

function getIstIsoDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getIstDaySeparator() {
  return "\n================================================================================\n";
}

function getTradeSeparator(sequence) {
  return `---------------------------        Trade ${sequence}        ---------------------------`;
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addUtcMonths(date, months) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function getPeriodDateRange(period, offset = 0) {
  const normalizedOffset = Math.min(
    0,
    Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0,
  );
  const todayKey = getIstIsoDateKey(new Date());
  const today = new Date(`${todayKey}T12:00:00+05:30`);

  if (period === "month") {
    const start = addUtcMonths(
      new Date(`${todayKey.slice(0, 8)}01T12:00:00+05:30`),
      normalizedOffset,
    );
    const nextMonthStart = addUtcMonths(start, 1);
    const end = normalizedOffset === 0 ? today : addUtcDays(nextMonthStart, -1);

    return {
      startDateKey: getIstIsoDateKey(start),
      endDateKey: getIstIsoDateKey(end),
      offset: normalizedOffset,
    };
  }

  const dayOfWeek = today.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const currentWeekStart = addUtcDays(today, -daysSinceMonday);
  const start = addUtcDays(currentWeekStart, normalizedOffset * 7);
  const end = normalizedOffset === 0 ? today : addUtcDays(start, 6);

  return {
    startDateKey: getIstIsoDateKey(start),
    endDateKey: getIstIsoDateKey(end),
    offset: normalizedOffset,
  };
}

function getAnalyticsPeriodLabel(period, offset = 0) {
  if (period === "month") {
    if (offset === 0) return "This month";
    if (offset === -1) return "Previous month";
    return `${Math.abs(offset)} months ago`;
  }

  if (offset === 0) return "This week";
  if (offset === -1) return "Previous week";
  return `${Math.abs(offset)} weeks ago`;
}

function isDateKeyInPeriod(dateKey, startDateKey, endDateKey) {
  return Boolean(dateKey) && dateKey >= startDateKey && dateKey <= endDateKey;
}

function getTradeDateKey(trade) {
  const timestamp = trade.exitTime || trade.entryTime;
  const date = timestamp ? new Date(timestamp) : new Date();

  return Number.isNaN(date.getTime())
    ? getIstIsoDateKey(new Date())
    : getIstIsoDateKey(date);
}

function getTradeDirection(trade) {
  return String(trade.entrySignal || "").startsWith("SHORT") ? "SHORT" : "LONG";
}

function getTradeUnderlying(trade) {
  const optionSymbol = String(trade.optionSymbol || "").toUpperCase();

  return optionSymbol.startsWith("BANKNIFTY") ? "BANKNIFTY" : "NIFTY";
}

function getTradeOptionType(trade) {
  const optionSymbol = String(trade.optionSymbol || "").toUpperCase();

  if (/\bPUT\b/.test(optionSymbol)) return "PUT";
  if (/\bCALL\b/.test(optionSymbol)) return "CALL";
  return "UNKNOWN";
}

function getTradeExpiryLabel(trade) {
  const optionSymbol = String(trade.optionSymbol || "").trim();
  const match = optionSymbol.match(/\b(\d{1,2}\s+[A-Z]{3})\b/i);

  return match ? match[1].toUpperCase() : "-";
}

function getTradeStrikePrice(trade) {
  const optionSymbol = String(trade.optionSymbol || "").trim();
  const match = optionSymbol.match(/\b(\d{4,6})\s+(CALL|PUT)\b/i);

  return match ? match[1] : "-";
}

function getTradeOutcome(trade) {
  const profit = Number(trade.realizedProfit);

  if (Number.isFinite(profit)) {
    if (profit > 0) return "WIN";
    if (profit < 0) return "LOSS";
    return "BREAKEVEN";
  }

  if (trade.status === "FAILED") return "FAILED";
  if (["RUNNING", "RUNNING_UNPROTECTED"].includes(trade.status)) return "OPEN";

  return "UNKNOWN";
}

function isTestTradeRecord(trade) {
  const dataSource = String(trade.dataSource || "").toUpperCase();
  const riskSource = String(trade.riskSource || "").toUpperCase();

  return Boolean(
    trade.analyticsSeed ||
      trade.isTestData ||
      trade.testData ||
      dataSource === "TEST_DUMMY" ||
      riskSource.includes("ANALYTICS_SEED"),
  );
}

function getDashboardTradeLabel(sequence) {
  const n = Number(sequence || 0);
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";

  return `${n}${suffix}`;
}

function getTradeDateTime(trade) {
  const timestamp =
    trade.exitTime || trade.entryTime || trade.updatedAt || trade.createdAt || "";
  const date = timestamp ? new Date(timestamp) : null;

  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function compareTradesByDate(a, b) {
  const aTime = getTradeDateTime(a)?.getTime() || 0;
  const bTime = getTradeDateTime(b)?.getTime() || 0;

  if (aTime !== bTime) {
    return aTime - bTime;
  }

  return Number(a.sequence || 0) - Number(b.sequence || 0);
}

function buildOutcomeStreaks(realizedTrades) {
  const orderedTrades = [...realizedTrades].sort(compareTradesByDate);
  const streaks = {
    currentType: "NONE",
    currentCount: 0,
    bestWinning: 0,
    bestLosing: 0,
  };

  orderedTrades.forEach((trade) => {
    const type =
      Number(trade.profit || 0) > 0
        ? "WIN"
        : Number(trade.profit || 0) < 0
          ? "LOSS"
          : "BREAKEVEN";

    if (type === "BREAKEVEN") {
      streaks.currentType = "NONE";
      streaks.currentCount = 0;
      return;
    }

    if (streaks.currentType === type) {
      streaks.currentCount += 1;
    } else {
      streaks.currentType = type;
      streaks.currentCount = 1;
    }

    if (type === "WIN") {
      streaks.bestWinning = Math.max(streaks.bestWinning, streaks.currentCount);
    }

    if (type === "LOSS") {
      streaks.bestLosing = Math.max(streaks.bestLosing, streaks.currentCount);
    }
  });

  return {
    currentType: streaks.currentType,
    currentCount: streaks.currentCount,
    bestWinning: streaks.bestWinning,
    bestLosing: streaks.bestLosing,
  };
}

function getTradePlannedLossAmount(trade) {
  const stopLossMoney = Math.abs(Number(trade.stopLossMoney || 0));

  if (Number.isFinite(stopLossMoney) && stopLossMoney > 0) {
    return roundMoney(stopLossMoney);
  }

  const riskPoints = Math.abs(Number(trade.riskPoints || 0));
  const quantity = Math.abs(Number(trade.quantity || 0));

  if (
    Number.isFinite(riskPoints) &&
    riskPoints > 0 &&
    Number.isFinite(quantity) &&
    quantity > 0
  ) {
    return roundMoney(riskPoints * quantity);
  }

  return null;
}

function getTradeRrr(trade) {
  const profit = Number(trade.profit);
  const plannedLoss = getTradePlannedLossAmount(trade);

  if (!Number.isFinite(profit) || !plannedLoss) {
    return null;
  }

  return roundMoney(profit / plannedLoss);
}

function getDateKeysBetween(startDateKey, endDateKey) {
  const keys = [];
  let cursor = new Date(`${startDateKey}T12:00:00+05:30`);
  const end = new Date(`${endDateKey}T12:00:00+05:30`);

  while (cursor <= end) {
    keys.push(getIstIsoDateKey(cursor));
    cursor = addUtcDays(cursor, 1);
  }

  return keys;
}

function getAnalyticsSeedTradePlan(symbol, index) {
  const profile = UNDERLYING_PROFILES[symbol] || UNDERLYING_PROFILES.NIFTY;
  const lots = symbol === "BANKNIFTY" ? 4 : 3;
  const quantity = profile.lotSize * lots;
  const riskPoints = profile.planningSlPoints;
  const plannedLoss = riskPoints * quantity;
  const strikeBase = symbol === "BANKNIFTY" ? 57900 : 24250;
  const strike = strikeBase + ((index % 5) - 2) * profile.strikeStep;
  const optionType = index % 2 === 0 ? "CALL" : "PUT";
  const entrySignal = optionType === "CALL" ? "LONG_ENTRY" : "SHORT_ENTRY";
  const exitSignal = optionType === "CALL" ? "LONG_EXIT" : "SHORT_EXIT";
  const rMultiples = [1.25, -1, 2.1, -0.75, 3.5, 1.8, -1, 5];
  const rMultiple = rMultiples[index % rMultiples.length];
  const realizedProfit = roundMoney(plannedLoss * rMultiple);

  return {
    profile,
    lots,
    quantity,
    riskPoints,
    plannedLoss,
    strike,
    optionType,
    entrySignal,
    exitSignal,
    rMultiple,
    realizedProfit,
  };
}

function buildAnalyticsSeedTrades(startDateKey, endDateKey) {
  const dateKeys = getDateKeysBetween(startDateKey, endDateKey);
  let sequence = 1;

  return dateKeys.flatMap((dateKey, dayIndex) => {
    const tradesForDay = dayIndex % 2 === 0 ? 3 : 2;

    return Array.from({ length: tradesForDay }, (_, slotIndex) => {
      const globalIndex = dayIndex * 3 + slotIndex;
      const symbol =
        (dayIndex + slotIndex) % 4 === 2 ? "BANKNIFTY" : "NIFTY";
      const plan = getAnalyticsSeedTradePlan(symbol, globalIndex);
      const entryHour = 9 + Math.floor((slotIndex + 1) * 1.45);
      const entryMinute = slotIndex % 2 === 0 ? 20 : 45;
      const exitMinute = entryMinute + 11;
      const entryTime = new Date(
        `${dateKey}T${String(entryHour).padStart(2, "0")}:${String(entryMinute).padStart(2, "0")}:00+05:30`,
      );
      const exitTime = new Date(
        `${dateKey}T${String(entryHour).padStart(2, "0")}:${String(exitMinute).padStart(2, "0")}:00+05:30`,
      );
      const tradeSequence = sequence++;
      const expiry = symbol === "BANKNIFTY" ? "30 JUL" : "07 JUL";

      return {
        id: `analytics-seed-${dateKey}-${tradeSequence}`,
        sequence: tradeSequence,
        analyticsSeed: true,
        isTestData: true,
        dataSource: "TEST_DUMMY",
        tradeMode: "PAPER",
        status: "MANUAL_EXIT",
        entrySignal: plan.entrySignal,
        entryTime: entryTime.toISOString(),
        entryOrderId: `ANALYTICS-SEED-BUY-${tradeSequence}`,
        securityId: `ANALYTICS-${tradeSequence}`,
        quantity: plan.quantity,
        optionSymbol: `${symbol} ${expiry} ${plan.strike} ${plan.optionType}`,
        premiumSlInterval: 15,
        riskPoints: plan.riskPoints,
        riskSource: "ANALYTICS_SEED_PLANNED_LOSS",
        exitSignal: plan.exitSignal,
        exitTime: exitTime.toISOString(),
        exitOrderId: `ANALYTICS-SEED-SELL-${tradeSequence}`,
        stopLossMoney: plan.plannedLoss,
        realizedProfit: plan.realizedProfit,
        rewardPoints:
          plan.realizedProfit > 0
            ? roundMoney(plan.riskPoints * plan.rMultiple)
            : null,
        riskRewardRatio:
          plan.realizedProfit > 0 ? roundMoney(plan.rMultiple) : null,
        riskReward:
          plan.realizedProfit > 0
            ? `1:${roundMoney(plan.rMultiple)}`
            : "-1",
      };
    });
  });
}

function parseAnalyticsLogStats(startDateKey, endDateKey) {
  const stats = {
    successfulEntries: 0,
    failedSignals: 0,
    longSignals: 0,
    shortSignals: 0,
  };

  if (!fs.existsSync(logPath)) {
    return stats;
  }

  fs.readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const timestampMatch = line.match(
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/,
      );
      const timestamp = timestampMatch ? new Date(timestampMatch[1]) : null;
      const dateKey = timestamp ? getIstIsoDateKey(timestamp) : "";

      if (!isDateKeyInPeriod(dateKey, startDateKey, endDateKey)) {
        return;
      }

      if (/Position changed to LONG/i.test(line)) {
        stats.successfulEntries += 1;
        stats.longSignals += 1;
      }

      if (/Position changed to SHORT/i.test(line)) {
        stats.successfulEntries += 1;
        stats.shortSignals += 1;
      }

      if (
        /ignored because|not filled|rejected|failed|Invalid webhook payload|Unknown signal/i.test(
          line,
        )
      ) {
        stats.failedSignals += 1;
      }
    });

  return stats;
}

function buildTradeAnalytics(
  period = "week",
  underlying = "ALL",
  optionType = "ALL",
  includeTestData = false,
  periodOffset = 0,
) {
  const normalizedPeriod = period === "month" ? "month" : "week";
  const periodRange = getPeriodDateRange(normalizedPeriod, periodOffset);
  const { startDateKey, endDateKey } = periodRange;
  const shouldIncludeTestData =
    includeTestData === true ||
    String(includeTestData ?? "false").toLowerCase() === "true";
  const normalizedUnderlying = ["NIFTY", "BANKNIFTY"].includes(
    String(underlying || "").toUpperCase(),
  )
    ? String(underlying).toUpperCase()
    : "ALL";
  const normalizedOptionType = ["CALL", "PUT"].includes(
    String(optionType || "").toUpperCase(),
  )
    ? String(optionType).toUpperCase()
    : "ALL";
  const history = readJsonFile(tradeHistoryPath);
  const historyTrades = Array.isArray(history?.trades) ? history.trades : [];
  const analyticsSeedTrades = shouldIncludeTestData
    ? buildAnalyticsSeedTrades(startDateKey, endDateKey)
    : [];
  const trades = [...historyTrades, ...analyticsSeedTrades]
        .filter((trade) =>
          isDateKeyInPeriod(getTradeDateKey(trade), startDateKey, endDateKey),
        )
        .filter((trade) => shouldIncludeTestData || !isTestTradeRecord(trade))
        .map((trade) => ({
          ...trade,
          dateKey: getTradeDateKey(trade),
          underlying: getTradeUnderlying(trade),
          direction: getTradeDirection(trade),
          optionType: getTradeOptionType(trade),
          expiry: getTradeExpiryLabel(trade),
          strikePrice: getTradeStrikePrice(trade),
          isTestData: isTestTradeRecord(trade),
          outcome: getTradeOutcome(trade),
          profit: Number.isFinite(Number(trade.realizedProfit))
            ? roundMoney(trade.realizedProfit)
            : null,
        }))
        .filter(
          (trade) =>
            (normalizedUnderlying === "ALL" ||
              trade.underlying === normalizedUnderlying) &&
            (normalizedOptionType === "ALL" ||
              trade.optionType === normalizedOptionType),
        )
;
  const logStats = parseAnalyticsLogStats(startDateKey, endDateKey);
  const realizedTrades = trades.filter((trade) => trade.profit !== null);
  const winners = realizedTrades.filter((trade) => trade.profit > 0);
  const losers = realizedTrades.filter((trade) => trade.profit < 0);
  const breakeven = realizedTrades.filter((trade) => trade.profit === 0);
  const grossProfit = roundMoney(
    winners.reduce((sum, trade) => sum + Number(trade.profit || 0), 0),
  );
  const grossLoss = roundMoney(
    losers.reduce((sum, trade) => sum + Math.abs(Number(trade.profit || 0)), 0),
  );
  const netPnl = roundMoney(grossProfit - grossLoss);
  const averageProfit = winners.length
    ? roundMoney(grossProfit / winners.length)
    : 0;
  const averageLoss = losers.length ? roundMoney(grossLoss / losers.length) : 0;
  const canUseLogStats =
    shouldIncludeTestData &&
    normalizedUnderlying === "ALL" &&
    normalizedOptionType === "ALL";
  const totalTrades =
    canUseLogStats
      ? Math.max(trades.length, logStats.successfulEntries)
      : trades.length;
  const winRate = realizedTrades.length
    ? roundMoney((winners.length / realizedTrades.length) * 100)
    : 0;
  const longTrades = trades.filter((trade) => trade.direction === "LONG").length;
  const shortTrades = trades.filter((trade) => trade.direction === "SHORT").length;
  const displayedLongTrades =
    canUseLogStats ? longTrades || logStats.longSignals : longTrades;
  const displayedShortTrades =
    canUseLogStats ? shortTrades || logStats.shortSignals : shortTrades;
  const displayedPositionTotal = displayedLongTrades + displayedShortTrades;
  const maxAbsPnl = Math.max(
    1,
    ...realizedTrades.map((trade) => Math.abs(Number(trade.profit || 0))),
  );
  const sortedRealizedTrades = [...realizedTrades].sort(compareTradesByDate);
  const outcomeStreaks = buildOutcomeStreaks(sortedRealizedTrades);
  const optionTypePnl = ["CALL", "PUT"].map((type) => ({
    label: type,
    value: roundMoney(
      realizedTrades
        .filter((trade) => trade.optionType === type)
        .reduce((sum, trade) => sum + Number(trade.profit || 0), 0),
    ),
  }));
  const optionTypePnlMagnitude = optionTypePnl.reduce(
    (sum, item) => sum + Math.abs(item.value),
    0,
  );
  optionTypePnl.forEach((item) => {
    item.percent = optionTypePnlMagnitude
      ? roundMoney((Math.abs(item.value) / optionTypePnlMagnitude) * 100)
      : 0;
  });
  const withAbsolutePercent = (items) => {
    const total = items.reduce((sum, item) => sum + Math.abs(Number(item.value || 0)), 0);
    return items.map((item) => ({
      ...item,
      percent: total ? roundMoney((Math.abs(Number(item.value || 0)) / total) * 100) : 0,
    }));
  };
  const averageByOptionType = (sourceTrades, negative = false) =>
    withAbsolutePercent(
      ["CALL", "PUT"].map((type) => {
        const matching = sourceTrades.filter((trade) => trade.optionType === type);
        const average = matching.length
          ? matching.reduce((sum, trade) => sum + Number(trade.profit || 0), 0) /
            matching.length
          : 0;
        return { label: type, value: roundMoney(negative ? -Math.abs(average) : average) };
      }),
    );

  return {
    period: normalizedPeriod,
    periodOffset: periodRange.offset,
    underlying: normalizedUnderlying,
    optionType: normalizedOptionType,
    includeTestData: shouldIncludeTestData,
    label: getAnalyticsPeriodLabel(normalizedPeriod, periodRange.offset),
    startDate: startDateKey,
    endDate: endDateKey,
    totals: {
      tradesTaken: totalTrades,
      successfulTrades: winners.length,
      failedSignals: canUseLogStats ? logStats.failedSignals : null,
      realizedTrades: realizedTrades.length,
      openTrades: trades.filter((trade) =>
        ["RUNNING", "RUNNING_UNPROTECTED"].includes(trade.status),
      ).length,
      winners: winners.length,
      losers: losers.length,
      breakeven: breakeven.length,
      winRate,
      netPnl,
      grossProfit,
      grossLoss,
      averageProfit,
      averageLoss,
      profitFactor: grossLoss > 0 ? roundMoney(grossProfit / grossLoss) : null,
      longTrades: displayedLongTrades,
      shortTrades: displayedShortTrades,
      currentStreakType: outcomeStreaks.currentType,
      currentStreakCount: outcomeStreaks.currentCount,
      bestWinningStreak: outcomeStreaks.bestWinning,
      bestLosingStreak: outcomeStreaks.bestLosing,
    },
    charts: {
      optionTypePnl,
      outcomeMix: withAbsolutePercent([
        { label: "WIN", value: winners.length },
        { label: "LOSS", value: losers.length },
        { label: "BREAKEVEN", value: breakeven.length },
      ]),
      optionTypeAverageProfit: averageByOptionType(winners),
      optionTypeAverageLoss: averageByOptionType(losers, true),
      underlyingPnl: withAbsolutePercent(
        ["NIFTY", "BANKNIFTY"].map((symbol) => ({
          label: symbol,
          value: roundMoney(
            realizedTrades
              .filter((trade) => trade.underlying === symbol)
              .reduce((sum, trade) => sum + Number(trade.profit || 0), 0),
          ),
        })),
      ),
      streakSequence: sortedRealizedTrades.slice(-12).map((trade) => ({
        label: Number(trade.profit || 0) > 0 ? "W" : Number(trade.profit || 0) < 0 ? "L" : "B",
        date: trade.dateKey,
        value: trade.profit || 0,
      })),
      pnlByTrade: sortedRealizedTrades.map((trade, index) => ({
        label: getDashboardTradeLabel(trade.sequence || index + 1),
        date: trade.dateKey,
        symbol: trade.underlying || "-",
        strikePrice: trade.strikePrice,
        expiry: trade.expiry,
        optionType: trade.optionType,
        riskReward: trade.riskReward || "-",
        rrr: getTradeRrr(trade),
        isTestData: trade.isTestData,
        value: trade.profit || 0,
        widthPercent: Math.max(
          4,
          Math.round((Math.abs(Number(trade.profit || 0)) / maxAbsPnl) * 100),
        ),
        outcome: trade.outcome,
        outcomeLabel:
          Number(trade.profit || 0) > 0
            ? "Profit"
            : Number(trade.profit || 0) < 0
              ? "Loss"
              : "Breakeven",
      })),
      positionMix: [
        {
          label: "LONG",
          value: displayedLongTrades,
          widthPercent: displayedPositionTotal
            ? Math.round((displayedLongTrades / displayedPositionTotal) * 100)
            : 0,
        },
        {
          label: "SHORT",
          value: displayedShortTrades,
          widthPercent: displayedPositionTotal
            ? Math.round((displayedShortTrades / displayedPositionTotal) * 100)
            : 0,
        },
      ],
    },
    recentTrades: realizedTrades.slice(-6).reverse().map((trade) => ({
      label: `${getDashboardTradeLabel(trade.sequence)} Trade`,
      direction: trade.direction,
      status: trade.status,
      optionSymbol: trade.optionSymbol,
      underlying: trade.underlying,
      profit: trade.profit,
      outcome: trade.outcome,
      dateKey: trade.dateKey,
    })),
  };
}

function getIstTimeLabel(timestampMs) {
  if (!timestampMs) {
    return "Unknown time";
  }

  return new Date(timestampMs).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function getLocalNetworkIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (net) =>
        net &&
        net.family === "IPv4" &&
        !net.internal &&
        net.address,
    )
    .map((net) => net.address);
}

function getTimeSeparator(timestampMs) {
  return `---------------------------        ${getIstTimeLabel(timestampMs)}        ---------------------------`;
}

function isEntryWebhook(line) {
  return /Webhook received: .*"signal":"(LONG_ENTRY|SHORT_ENTRY)"/.test(line);
}

function isNonTradeEntryResult(line) {
  return (
    /(LONG_ENTRY|SHORT_ENTRY).*(ignored|failed|not filled|rejected)/i.test(
      line,
    ) ||
    /daily trade limit reached|calculated quantity is invalid/i.test(line)
  );
}

function isPositionChanged(line) {
  return /Position changed to (LONG|SHORT)/.test(line);
}

function isTradeTerminalResult(line) {
  return /Position closed:|premium stop-loss hit|safety exit requested|stopped immediately/i.test(
    line,
  );
}

function getStopLossOrderIdFromLogLine(line) {
  const patterns = [
    /Premium stop-loss hit:\s*([A-Z0-9-]+)/i,
    /Manual SL trail confirmed:\s*orderId=([A-Z0-9-]+)/i,
    /Automatic SL trail confirmed:\s*orderId=([A-Z0-9-]+)/i,
    /"orderId"\s*:\s*"([^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function rememberTradeStopLossOrder(tradesByStopLossOrderId, trade, line) {
  const stopLossOrderId = getStopLossOrderIdFromLogLine(line);

  if (stopLossOrderId) {
    tradesByStopLossOrderId.set(stopLossOrderId, trade);
  }
}

function isReadinessLifecycle(line) {
  return /LIFECYCLE/i.test(line) && !/MANUAL_SIGNAL/i.test(line);
}

function formatLogTimestamp(line) {
  return line.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
    (match) => {
      return new Date(match).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour12: true,
      });
    },
  );
}

function getParsedLogLine(line) {
  const timestampMatch = line.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/,
  );
  const timestamp = timestampMatch ? new Date(timestampMatch[1]) : null;

  return {
    raw: line,
    display: formatLogTimestamp(line),
    timestampMs: timestamp ? timestamp.getTime() : 0,
    minuteKey: timestamp
      ? Math.floor(timestamp.getTime() / (60 * 1000)).toString()
      : "unknown",
    dateKey: timestamp ? getIstDateKey(timestamp) : "unknown",
    daySeparator: timestamp ? getIstDaySeparator(timestamp) : "",
  };
}

function getLogDay(daysByKey, parsedLine) {
  if (!daysByKey.has(parsedLine.dateKey)) {
    daysByKey.set(parsedLine.dateKey, {
      daySeparator: parsedLine.daySeparator,
      latestMs: 0,
      general: [],
      trades: [],
    });
  }

  return daysByKey.get(parsedLine.dateKey);
}

function getGeneralTimeSections(lines) {
  const bucketsByMinute = new Map();

  lines.forEach((line) => {
    if (!bucketsByMinute.has(line.minuteKey)) {
      bucketsByMinute.set(line.minuteKey, {
        latestMs: 0,
        lines: [],
      });
    }

    const bucket = bucketsByMinute.get(line.minuteKey);
    bucket.latestMs = Math.max(bucket.latestMs, line.timestampMs);
    bucket.lines.push(line);
  });

  return Array.from(bucketsByMinute.values()).map((bucket) => ({
    latestMs: bucket.latestMs,
    lines: [
      getTimeSeparator(bucket.latestMs),
      ...bucket.lines
        .slice()
        .sort((a, b) => b.timestampMs - a.timestampMs)
        .map((line) => line.display),
    ],
  }));
}

function formatDashboardLogs(content, telegramEnabled = false) {
  const tradeHistory = readJsonFile(tradeHistoryPath);
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => telegramEnabled || !/Telegram/i.test(line));

  if (!lines.length) {
    return "No logs yet.";
  }

  const daysByKey = new Map();
  const tradesByStopLossOrderId = new Map();
  let currentTrade = null;
  let pendingTrade = null;

  lines.slice(-160).forEach((line) => {
    const parsedLine = getParsedLogLine(line);
    const day = getLogDay(daysByKey, parsedLine);
    day.latestMs = Math.max(day.latestMs, parsedLine.timestampMs);

    if (pendingTrade && pendingTrade.dateKey !== parsedLine.dateKey) {
      pendingTrade.day.general.push(...pendingTrade.lines);
      pendingTrade = null;
    }

    if (currentTrade && currentTrade.dateKey !== parsedLine.dateKey) {
      currentTrade = null;
    }

    // Operational start/stop events belong to their day, never to an open
    // signal/trade block left over from earlier activity.
    if (isReadinessLifecycle(line)) {
      day.general.push(parsedLine);
      return;
    }

    const stopLossOrderId = getStopLossOrderIdFromLogLine(line);
    const matchedTrade = stopLossOrderId
      ? tradesByStopLossOrderId.get(stopLossOrderId)
      : null;

    if (matchedTrade && !isEntryWebhook(line)) {
      matchedTrade.lines.push(parsedLine);
      matchedTrade.latestMs = Math.max(
        matchedTrade.latestMs,
        parsedLine.timestampMs,
      );

      if (isTradeTerminalResult(line) && currentTrade === matchedTrade) {
        currentTrade = null;
      }

      return;
    }

    if (isEntryWebhook(line)) {
      if (pendingTrade) {
        pendingTrade.day.general.push(...pendingTrade.lines);
      }

      pendingTrade = {
        dateKey: parsedLine.dateKey,
        day,
        latestMs: parsedLine.timestampMs,
        lines: [parsedLine],
      };
      currentTrade = null;
      return;
    }

    if (pendingTrade) {
      pendingTrade.lines.push(parsedLine);
      pendingTrade.latestMs = Math.max(
        pendingTrade.latestMs,
        parsedLine.timestampMs,
      );

      if (isNonTradeEntryResult(line)) {
        pendingTrade.day.general.push(...pendingTrade.lines);
        pendingTrade = null;
        return;
      }

      if (isPositionChanged(line)) {
        const sequence = pendingTrade.day.trades.length + 1;
        const persistedTrade =
          tradeHistory?.date === getIstIsoDateKey(new Date(parsedLine.timestampMs))
            ? tradeHistory.trades?.find(
                (item) => Number(item.sequence) === sequence,
              )
            : null;
        const trade = {
          sequence,
          tradeMode: persistedTrade?.tradeMode || null,
          entryTime: persistedTrade?.entryTime || null,
          lines: pendingTrade.lines,
          dateKey: pendingTrade.dateKey,
          latestMs: pendingTrade.latestMs,
        };

        pendingTrade.day.trades.push(trade);
        currentTrade = trade;
        pendingTrade = null;
      }

      return;
    }

    if (currentTrade) {
      currentTrade.lines.push(parsedLine);
      currentTrade.latestMs = Math.max(
        currentTrade.latestMs,
        parsedLine.timestampMs,
      );
      rememberTradeStopLossOrder(tradesByStopLossOrderId, currentTrade, line);

      if (isTradeTerminalResult(line)) {
        currentTrade = null;
      }

      return;
    }

    day.general.push(parsedLine);
  });

  if (pendingTrade) {
    pendingTrade.day.general.push(...pendingTrade.lines);
  }

  return Array.from(daysByKey.values())
    .sort((a, b) => b.latestMs - a.latestMs)
    .flatMap((day) => {
      const sections = [
        ...day.trades.map((trade) => ({
          latestMs: trade.latestMs,
          lines: [
            getTimeSeparator(trade.latestMs),
            getTradeSeparator(trade.sequence),
            ...trade.lines
              .slice()
              .sort((a, b) => b.timestampMs - a.timestampMs)
              .map((line) => line.display),
            ...(!trade.lines.some((line) =>
              /Execution context:/i.test(line.raw),
            ) && trade.tradeMode
              ? [
                  formatLogTimestamp(
                    `${trade.entryTime || new Date(trade.latestMs).toISOString()} ` +
                      `[INFO] Execution context: tradeMode=${trade.tradeMode} ` +
                      `orderRoute=${
                        trade.tradeMode === "PAPER"
                          ? "SIMULATION"
                          : `${trade.tradeMode}_DHAN`
                      }`,
                  ),
                ]
              : []),
          ],
        })),
        ...getGeneralTimeSections(day.general),
      ]
        .sort((a, b) => b.latestMs - a.latestMs)
        .flatMap((section) => section.lines);

      if (day.daySeparator) {
        sections.push(day.daySeparator);
      }

      return sections;
    })
    .join("\n");
}

// Dashboard bootstrap endpoint: config plus live process/tunnel status.
app.get("/api/config", async (req, res) => {
  const reset = applyDailyControlReset(envPath, {
    logger: { info: appendLifecycleLog },
  });
  const env = readEnv();
  const underlyingProfile = getUnderlyingProfile(env);

  const algoRunning = await isAlgoActuallyRunning();
  const ngrokHealth = await getNgrokHealth();

  res.json({
    ALLOW_BUY: env.ALLOW_BUY,
    ALLOW_SELL: env.ALLOW_SELL,
    ALLOW_NIFTY_TV_SIGNALS: env.ALLOW_NIFTY_TV_SIGNALS || "true",
    ALLOW_BANKNIFTY_TV_SIGNALS: env.ALLOW_BANKNIFTY_TV_SIGNALS || "true",
    ...getTradingViewTimeframeResponseFields(env),
    PAPER_TRADE: env.PAPER_TRADE,
    TELEGRAM_ENABLED:
      String(env.TELEGRAM_ENABLED).toLowerCase() === "true" ? "true" : "false",
    DHAN_ENV: String(env.DHAN_ENV || "LIVE").toUpperCase(),
    DHAN_SANDBOX_CLIENT_ID,
    DHAN_SANDBOX_CONFIGURED: Boolean(env.DHAN_SANDBOX_ACCESS_TOKEN),
    NO_TRADE_TODAY: env.NO_TRADE_TODAY,
    AUTO_PREMIUM_SL: env.AUTO_PREMIUM_SL,
    PREMIUM_SL_INTERVAL: env.PREMIUM_SL_INTERVAL,
    PREMIUM_SL_LIMIT_BAND: env.PREMIUM_SL_LIMIT_BAND,
    ...getPremiumHugeCandleResponseFields(env, underlyingProfile.symbol),
    AUTO_TRAIL_SL: env.AUTO_TRAIL_SL || "false",
    AUTO_TRAIL_INTERVAL_MS: env.AUTO_TRAIL_INTERVAL_MS || "15000",
    TRAIL_MODE: env.TRAIL_MODE || "CONSERVATIVE",
    TRAIL_COST_TO_COST_PERCENT: env.TRAIL_COST_TO_COST_PERCENT || "7",
    TRAIL_CLASSIC_TRIGGER_RR_1: env.TRAIL_CLASSIC_TRIGGER_RR_1 || "3",
    TRAIL_CLASSIC_LOCK_RR_1: env.TRAIL_CLASSIC_LOCK_RR_1 || "1",
    TRAIL_CLASSIC_TRIGGER_RR_2: env.TRAIL_CLASSIC_TRIGGER_RR_2 || "5",
    TRAIL_CLASSIC_LOCK_RR_2: env.TRAIL_CLASSIC_LOCK_RR_2 || "3",
    TRAIL_CLASSIC_TRIGGER_RR_3: env.TRAIL_CLASSIC_TRIGGER_RR_3 || "7",
    TRAIL_CLASSIC_LOCK_RR_3: env.TRAIL_CLASSIC_LOCK_RR_3 || "5",

    MAX_DAILY_TRADES: env.MAX_DAILY_TRADES,
    MAX_OPEN_POSITIONS: env.MAX_OPEN_POSITIONS,

    UNDERLYING_SYMBOL: underlyingProfile.symbol,
    UNDERLYING_DISPLAY_NAME: underlyingProfile.displayName,
    UNDERLYING_SPOT_SEGMENT: underlyingProfile.spotSegment,
    UNDERLYING_SPOT_SECURITY_ID: underlyingProfile.spotSecurityId,
    STRIKE_STEP: String(underlyingProfile.strikeStep),
    NUMBER_OF_LOTS: env.NUMBER_OF_LOTS,
    LOT_SIZE: String(underlyingProfile.lotSize),

    TRADING_CAPITAL: env.TRADING_CAPITAL,
    RISK_MODE: env.RISK_MODE,
    RISK_PERCENT: env.RISK_PERCENT,
    PLANNING_SL_POINTS: String(underlyingProfile.planningSlPoints),
    MARKET_BIAS: env.MARKET_BIAS,

    DHAN_TOKEN_UPDATED_AT: env.DHAN_TOKEN_UPDATED_AT,
    DHAN_SANDBOX_TOKEN_UPDATED_AT: env.DHAN_SANDBOX_TOKEN_UPDATED_AT,

    algoRunning,
    ngrokRunning: ngrokHealth.running,
    ngrokUrl: ngrokHealth.url,
    CONTROL_PANEL_RESET_DATE: env.CONTROL_PANEL_RESET_DATE,
    dailyControlResetApplied: reset.applied,
  });
});

// Check whether the algo server is responding on its status endpoint.
async function isAlgoActuallyRunning() {
  try {
    await axios.get("http://localhost:3000/status", {
      timeout: 1500,
    });

    return true;
  } catch (error) {
    return false;
  }
}

// Stop only the listener on port 3000. This also works after the dashboard
// restarts and no longer owns the original child-process handle.
function stopAlgoListener() {
  return new Promise((resolve) => {
    let output = "";
    const lookup = spawn("lsof", ["-tiTCP:3000", "-sTCP:LISTEN"]);
    lookup.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    lookup.on("error", () => resolve(false));
    lookup.on("exit", () => {
      const pids = output
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
      pids.forEach((pid) => {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          // It may have exited between discovery and termination.
        }
      });
      resolve(pids.length > 0);
    });
  });
}

const NGROK_API_URLS = [
  "http://127.0.0.1:4040/api/tunnels",
  "http://127.0.0.1:4041/api/tunnels",
  "http://127.0.0.1:4042/api/tunnels",
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopAllNgrokProcesses() {
  return new Promise((resolve) => {
    const pkill = spawn("pkill", ["ngrok"]);

    pkill.on("error", () => resolve());
    pkill.on("exit", () => resolve());
  });
}

// Ask ngrok's local APIs for the current public HTTPS tunnel.
async function getNgrokHealth() {
  const tunnels = [];

  await Promise.all(
    NGROK_API_URLS.map(async (apiUrl) => {
      try {
        const response = await axios.get(apiUrl, {
          timeout: 700,
        });

        response.data.tunnels
          .filter((tunnel) => tunnel.proto === "https")
          .forEach((tunnel) => tunnels.push({ ...tunnel, apiUrl }));
      } catch (error) {
        // It is normal for unused ngrok API ports to be closed.
      }
    }),
  );

  const tunnel = tunnels[0];

  if (!tunnel) {
    return {
      running: false,
      url: "",
      tunnelCount: 0,
      duplicate: false,
    };
  }

  return {
    running: true,
    url: tunnel.public_url + "/webhook",
    tunnelCount: tunnels.length,
    duplicate: tunnels.length > 1,
  };
}

// Save dashboard-edited settings back to .env.
app.post("/api/config", (req, res) => {
  const updates = { ...req.body };
  const previousEnv = readEnv();

  if (updates.DHAN_ENV) {
    updates.DHAN_ENV =
      String(updates.DHAN_ENV).toUpperCase() === "SANDBOX"
        ? "SANDBOX"
        : "LIVE";
  }

  if (updates.UNDERLYING_SYMBOL) {
    updates.UNDERLYING_SYMBOL = normalizeUnderlyingSymbol(updates.UNDERLYING_SYMBOL);
  }

  syncPremiumHugeCandleUpdates(updates, previousEnv);
  normalizePairedPermissionUpdates(updates, previousEnv);

  if (Object.prototype.hasOwnProperty.call(updates, "PAPER_TRADE")) {
    const paperTradeEnabled = String(updates.PAPER_TRADE).toLowerCase() === "true";

    updates.AUTO_PREMIUM_SL = paperTradeEnabled ? "false" : "true";
    updates.AUTO_TRAIL_SL = paperTradeEnabled ? "false" : "true";
  }

  writeEnv(updates);
  res.json({ success: true });
});

// Start the algo webhook server as a child process.
app.post("/api/start-server", async (req, res) => {
  keepAlgoRunning = true;
  if (algoProcess) {
    clearAlgoOutageAlert();
    appendLifecycleLog("Algo server start requested but already running");
    return res.json({ success: true, message: "Algo server already running" });
  }

  if (await isAlgoActuallyRunning()) {
    clearAlgoOutageAlert();
    appendLifecycleLog("Algo server start requested but already running on port 3000");
    return res.json({ success: true, message: "Algo server already running" });
  }

  appendLifecycleLog("Algo server start requested");

  algoProcess = spawn("node", ["src/server.js"], {
    cwd: path.join(__dirname, ".."),
    shell: true,
    stdio: "inherit",
  });

  algoProcess.on("exit", (code, signal) => {
    appendLifecycleLog(
      `Algo server process exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      code === 0 || signal === "SIGTERM" ? "info" : "warn",
    );
    algoProcess = null;
    if (keepAlgoRunning && !shuttingDown) {
      appendLifecycleLog("Algo server stopped unexpectedly; restarting in 5 seconds", "warn");
      scheduleAlgoOutageAlert();
      setTimeout(() => {
        if (keepAlgoRunning && !shuttingDown) {
          axios.post(`http://localhost:${PORT}/api/start-server`).catch((error) =>
            appendLifecycleLog(`Algo server automatic restart failed: ${error.message}`, "error"),
          );
        }
      }, SELF_HEAL_DELAY_MS);
    }
  });

  res.json({ success: true, message: "Algo server started" });
});

// Stop the child algo server if this dashboard started it.
app.post("/api/stop-server", async (req, res) => {
  keepAlgoRunning = false;
  clearAlgoOutageAlert();
  const stoppedListener = await stopAlgoListener();
  if (!algoProcess && !stoppedListener) {
    appendLifecycleLog("Algo server stop requested but dashboard has no child process");
    return res.json({ success: true, message: "Algo server not running" });
  }

  appendLifecycleLog("Algo server stop requested");
  if (algoProcess) algoProcess.kill();
  algoProcess = null;

  res.json({ success: true, message: "Algo server stopped" });
});

// Start ngrok so TradingView can reach the local webhook.
app.post("/api/start-ngrok", async (req, res) => {
  keepNgrokRunning = true;
  if (ngrokNextRestartAt > Date.now()) {
    return res.json({
      success: true,
      message: "Ngrok restart is waiting for the recovery backoff",
    });
  }
  if (ngrokStarting) {
    appendLifecycleLog("Ngrok start requested while startup is already in progress");
    return res.json({
      success: true,
      message: "Ngrok startup already in progress",
    });
  }

  ngrokStarting = true;

  try {
    const health = await getNgrokHealth();

    if (health.running && !health.duplicate) {
      clearNgrokRestartState();
      appendLifecycleLog(
        `Ngrok start requested but already running url=${health.url || "unknown"}`,
      );
      return res.json({
        success: true,
        message: "Ngrok already running",
      });
    }

    if (health.duplicate) {
      appendLifecycleLog(
        `Ngrok duplicate tunnels detected count=${health.tunnelCount}; restarting cleanly`,
        "warn",
      );
      await stopAllNgrokProcesses();
      await delay(1000);
    }

    appendLifecycleLog("Ngrok start requested");

    ngrokProcess = spawn("ngrok", ["http", "3000"], {
      shell: true,
      stdio: "inherit",
    });

    ngrokProcess.on("exit", (code, signal) => {
      appendLifecycleLog(
        `Ngrok process exited code=${code ?? "null"} signal=${signal ?? "null"}`,
        code === 0 || signal === "SIGTERM" ? "info" : "warn",
      );
      ngrokProcess = null;
      if (keepNgrokRunning && !shuttingDown) {
        scheduleNgrokRestart();
      }
    });

    return res.json({
      success: true,
      message: "Ngrok started",
    });
  } catch (error) {
    appendLifecycleLog(`Ngrok start failed: ${error.message}`, "error");
    return res.json({
      success: false,
      message: error.message,
    });
  } finally {
    ngrokStarting = false;
  }
});

// Stop ngrok, including any process that may have been started separately.
app.post("/api/stop-ngrok", async (req, res) => {
  keepNgrokRunning = false;
  clearNgrokRestartState();
  try {
    appendLifecycleLog("Ngrok stop requested");

    if (ngrokProcess) {
      ngrokProcess.kill();
      ngrokProcess = null;
    }

    await stopAllNgrokProcesses();

    res.json({
      success: true,
      message: "Ngrok stopped",
    });
  } catch (error) {
    appendLifecycleLog(`Ngrok stop failed: ${error.message}`, "error");

    res.json({
      success: false,
      message: error.message,
    });
  }
});

// One-click startup used by the macOS launcher. Existing individual controls
// remain available and an intentional Stop disables recovery for that service.
app.post("/api/start-all", async (req, res) => {
  keepAlgoRunning = true;
  keepNgrokRunning = true;

  const results = await Promise.allSettled([
    axios.post(`http://localhost:${PORT}/api/start-server`, null, { timeout: 5000 }),
    axios.post(`http://localhost:${PORT}/api/start-ngrok`, null, { timeout: 5000 }),
  ]);
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || "Unknown startup error");

  appendLifecycleLog(
    failures.length
      ? `One-click startup completed with warnings: ${failures.join("; ")}`
      : "One-click startup requested for algo server and ngrok",
    failures.length ? "warn" : "info",
  );
  res.status(failures.length ? 207 : 200).json({
    success: failures.length === 0,
    message: failures.length ? "Startup needs attention" : "Startup initiated",
    failures,
  });

  setTimeout(async () => {
    const [algoRunning, ngrokHealth] = await Promise.all([
      isAlgoActuallyRunning(),
      getNgrokHealth(),
    ]);
    let dhanConnected = false;
    let dhanMessage = "Algo server unavailable";
    if (algoRunning) {
      try {
        const response = await axios.get("http://localhost:3000/dhan-health", { timeout: 6000 });
        dhanConnected = Boolean(response.data.connected);
        dhanMessage = response.data.message || "";
      } catch (error) {
        dhanMessage = error.message;
      }
    }

    if (!(algoRunning && ngrokHealth.running && dhanConnected)) {
      sendTelegram(
        `⚠️ IC Algo Bot needs attention. Server: ${algoRunning ? "running" : "stopped"}; ngrok: ${ngrokHealth.running ? "running" : "stopped"}; Dhan: ${dhanMessage}`,
      );
    }
  }, PERSISTENT_OUTAGE_ALERT_MS);
});

// Consolidated readiness result for the launcher and dashboard diagnostics.
app.get("/api/readiness", async (req, res) => {
  const [algoRunning, ngrokHealth] = await Promise.all([
    isAlgoActuallyRunning(),
    getNgrokHealth(),
  ]);
  let dhan = { connected: false, message: "Algo server is still starting" };
  if (algoRunning) {
    try {
      const response = await axios.get("http://localhost:3000/dhan-health", { timeout: 6000 });
      dhan = response.data;
    } catch (error) {
      dhan = { connected: false, message: error.message };
    }
  }

  const ready = algoRunning && ngrokHealth.running && Boolean(dhan.connected);
  res.status(ready ? 200 : 503).json({
    ready,
    algoRunning,
    ngrokRunning: ngrokHealth.running,
    ngrokUrl: ngrokHealth.url,
    dhanConnected: Boolean(dhan.connected),
    dhanMessage: dhan.message || "",
  });
});

// Proxy the algo server status into the dashboard.
app.get("/api/algo-status", async (req, res) => {
  try {
    const paperTrade =
      req.query.paperTrade === "true" || req.query.paperTrade === "false"
        ? `?paperTrade=${req.query.paperTrade}`
        : "";
    const response = await axios.get(`http://localhost:3000/status${paperTrade}`, {
      timeout: 2000,
    });

    res.json({
      running: true,
      ...response.data,
    });
  } catch (error) {
    res.json({
      running: false,
      currentPosition: null,
      lastSignal: "",
      lastSignalTime: "",
      lastTrades: [],
      message: "Algo server not reachable",
    });
  }
});

app.get("/api/trade-charges", async (req, res) => {
  try {
    const response = await axios.get("http://localhost:3000/trade-charges", {
      timeout: 15000,
    });
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || "Trade charges unavailable",
    });
  }
});

// Return the current public webhook URL from ngrok's local API.
app.get("/api/ngrok-url", async (req, res) => {
  try {
    const health = await getNgrokHealth();

    res.json({
      success: true,
      running: health.running,
      url: health.url,
    });
  } catch (error) {
    res.json({
      success: false,
      running: false,
      url: "",
    });
  }
});

// Return current public and local IP details for broker allowlist diagnostics.
app.get("/api/network-ip", async (req, res) => {
  const localIps = getLocalNetworkIps();

  try {
    const response = await axios.get("https://api.ipify.org?format=json", {
      timeout: 3000,
    });

    res.json({
      publicIp: response.data.ip || "",
      localIps,
      checkedAt: new Date().toISOString(),
      error: "",
    });
  } catch (error) {
    res.json({
      publicIp: "",
      localIps,
      checkedAt: new Date().toISOString(),
      error: "Public IP unavailable",
    });
  }
});

app.get("/api/tradingview-indicator", (req, res) => {
  if (!fs.existsSync(tradingViewIndicatorPath)) {
    return res.status(404).json({
      success: false,
      message: "TradingView indicator file not found",
    });
  }

  res.download(
    tradingViewIndicatorPath,
    "nikhil-inside-candle-15min.pine",
  );
});

// Hard safety action: disable entries and block all trading for the day.
app.post("/api/emergency-stop", (req, res) => {
  writeEnv({
    ALLOW_BUY: "false",
    ALLOW_SELL: "false",
    NO_TRADE_TODAY: "true",
  });

  res.json({
    success: true,
    message: "🚨 Emergency stop activated. Trading disabled.",
  });
});

// Send a dashboard-generated signal to the algo webhook for manual testing.
app.post("/api/test-signal", async (req, res) => {
  const payload = req.body;
  const beforeSnapshot = await getAlgoSnapshot();
  const manualSignalContext = getManualSignalLogContext(payload);

  try {
    appendLifecycleLog(`MANUAL_SIGNAL requested ${manualSignalContext}`);

    const response = await axios.post(
      "http://localhost:3000/webhook",
      payload,
      {
        timeout: 30000,
      },
    );

    const webhookResult = response.data;
    const webhookRejected =
      webhookResult &&
      typeof webhookResult === "object" &&
      webhookResult.success === false;

    res.json({
      success: !webhookRejected,
      message: webhookRejected
        ? webhookResult.message || `Test signal rejected: ${payload.signal}`
        : `Test signal sent: ${payload.signal}`,
      response: webhookResult,
    });
    appendLifecycleLog(`MANUAL_SIGNAL completed ${manualSignalContext}`);
  } catch (error) {
    const afterSnapshot = await getAlgoSnapshot();

    if (didAlgoStateChange(beforeSnapshot, afterSnapshot)) {
      appendLifecycleLog(
        `MANUAL_SIGNAL response lost after processing ${manualSignalContext}: ${error.message}`,
        "warn",
      );

      return res.json({
        success: true,
        warning: true,
        message: `Signal processed locally, but response was lost: ${error.message}`,
        error: error.message,
        algoStatus: afterSnapshot.status,
      });
    }

    appendLifecycleLog(`MANUAL_SIGNAL failed ${manualSignalContext}: ${error.message}`, "warn");

    res.json({
      success: false,
      message: "Test signal failed. Is algo server running?",
      error: error.message,
    });
  }
});

app.post("/api/trail-stop-loss", async (req, res) => {
  try {
    const response = await axios.post(
      "http://localhost:3000/trail-stop-loss",
      req.body,
      {
        timeout: 10000,
      },
    );

    res.status(response.status).json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message:
        error.response?.data?.message ||
        "Stop-loss trail failed. Is algo server running?",
      error: error.response?.data?.error || error.message,
    });
  }
});

// Return recent log entries newest-first for the dashboard log viewer.
app.get("/api/logs", (req, res) => {
  try {
    if (!fs.existsSync(logPath)) {
      return res.json({
        success: true,
        logs: "No log file found yet.",
      });
    }

    const content = fs.readFileSync(logPath, "utf8");
    const env = readEnv();
    const lastLines = formatDashboardLogs(
      content,
      String(env.TELEGRAM_ENABLED).toLowerCase() === "true",
    );

    res.json({
      success: true,
      logs: lastLines,
    });
  } catch (error) {
    res.json({
      success: false,
      logs: error.message,
    });
  }
});

app.get("/api/trade-analytics", (req, res) => {
  try {
    res.json({
      success: true,
      analytics: buildTradeAnalytics(
        req.query.period,
        req.query.underlying,
        req.query.optionType,
        req.query.includeTestData,
        req.query.offset,
      ),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Manual, non-executed trade outcomes used for timeframe streak planning.
app.get("/api/streak-planner", (req, res) => {
  try {
    res.json({ success: true, planner: readStreakPlanner() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/streak-planner", (req, res) => {
  try {
    res.json({ success: true, planner: writeStreakPlanner(req.body) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Proxy Dhan health from the algo server so the dashboard has one API host.
app.get("/api/dhan-health", async (req, res) => {
  try {
    const response = await axios.get("http://localhost:3000/dhan-health", {
      timeout: 5000,
    });

    res.json(response.data);
  } catch (error) {
    res.json({
      connected: false,
      message: "Algo server not reachable",
    });
  }
});

// Fetch active underlying spot LTP through the algo server for manual signal price prefill.
app.get("/api/nifty-spot", async (req, res) => {
  try {
    const response = await axios.get("http://localhost:3000/nifty-spot", {
      timeout: 5000,
    });

    res.json(response.data);
  } catch (error) {
    res.json({
      success: false,
      message: `${getUnderlyingProfile(readEnv()).displayName} spot price unavailable`,
      error: error.response?.data || error.message,
    });
  }
});

// Proxy manual ATM option quotes from the algo server.
app.get("/api/manual-signal-preview", async (req, res) => {
  try {
    const response = await axios.get(
      "http://localhost:3000/manual-signal-preview",
      {
        params: {
          price: req.query.price,
          interval: req.query.interval,
        },
        timeout: 10000,
      },
    );
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || "Option premium unavailable",
      error: error.response?.data || error.message,
    });
  }
});

// Return the nearest tradable option expiry across supported index underlyings.
app.get("/api/nifty-expiry", (req, res) => {
  try {
    const nearest = getNearestIndexExpiry();
    const profile = nearest?.profile || getUnderlyingProfile(readEnv());
    const expiry = nearest?.expiry || null;

    res.json({
      success: !!expiry,
      expiry,
      underlyingSymbol: profile.symbol,
      underlyingDisplayName: profile.displayName,
      message: expiry
        ? `Next ${profile.displayName} expiry found`
        : "No index expiry found",
    });
  } catch (error) {
    const profile = getUnderlyingProfile(readEnv());

    res.json({
      success: false,
      expiry: null,
      underlyingSymbol: profile.symbol,
      underlyingDisplayName: profile.displayName,
      message: `${profile.displayName} expiry unavailable`,
      error: error.message,
    });
  }
});

app.get("/api/index-expiries", (req, res) => {
  try {
    const now = new Date();
    const expiries = Object.values(UNDERLYING_PROFILES).map((profile) => ({
      underlyingSymbol: profile.symbol,
      underlyingDisplayName: profile.displayName,
      expiry: getNextNiftyExpiry(profile, now),
    }));

    res.json({
      success: true,
      expiries,
    });
  } catch (error) {
    res.json({
      success: false,
      expiries: [],
      message: "Index expiries unavailable",
      error: error.message,
    });
  }
});

// Return the next NSE F&O trading holiday for planning around market closures.
app.get("/api/next-market-holiday", async (req, res) => {
  try {
    const holiday = await getNextNseHoliday();

    res.json({
      success: !!holiday,
      holiday,
      message: holiday ? "Next market holiday found" : "No market holiday found",
    });
  } catch (error) {
    res.json({
      success: false,
      holiday: null,
      message: "Market holiday unavailable",
      error: error.message,
    });
  }
});

// Return India VIX from NSE's index feed for quick volatility context.
app.get("/api/india-vix", async (req, res) => {
  try {
    const vix = await getIndiaVix();

    res.json({
      success: !!vix,
      vix,
      message: vix ? "India VIX found" : "India VIX unavailable",
    });
  } catch (error) {
    res.json({
      success: false,
      vix: null,
      message: "India VIX unavailable",
      error: error.message,
    });
  }
});

// Return RBI current policy rates and FBIL exchange rates from RBI's homepage.
app.get("/api/rbi-market-intel", async (req, res) => {
  try {
    const intel = await getRbiMarketIntel();

    res.json({
      success: true,
      intel,
      message: "RBI market intel found",
    });
  } catch (error) {
    res.json({
      success: false,
      intel: null,
      message: "RBI market intel unavailable",
      error: error.message,
    });
  }
});

// Store a refreshed Dhan token and timestamp in .env.
app.post("/api/update-dhan-token", (req, res) => {
  const { token, environment } = req.body;
  const dhanEnvironment =
    String(environment || readEnv().DHAN_ENV).toUpperCase() === "SANDBOX"
      ? "SANDBOX"
      : "LIVE";

  if (!token) {
    return res.status(400).json({
      success: false,
      message: "Token is required",
    });
  }

  if (dhanEnvironment === "SANDBOX") {
    writeEnv({
      DHAN_SANDBOX_CLIENT_ID,
      DHAN_SANDBOX_ACCESS_TOKEN: token,
      DHAN_SANDBOX_TOKEN_UPDATED_AT: getIstIsoString(),
    });
  } else {
    writeEnv({
      DHAN_ACCESS_TOKEN: token,
      DHAN_TOKEN_UPDATED_AT: getIstIsoString(),
    });
  }

  res.json({
    success: true,
    message: `${dhanEnvironment} Dhan credentials updated`,
  });
});

// Start the local dashboard server.
app.listen(PORT, () => {
  appendLifecycleLog(`Control dashboard started on port ${PORT}`);
  console.log(`Control dashboard running at http://localhost:${PORT}`);

  if (process.env.IC_AUTO_MANAGE === "true") {
    setTimeout(() => {
      axios.post(`http://localhost:${PORT}/api/start-all`).catch((error) =>
        appendLifecycleLog(`Automatic startup failed: ${error.message}`, "error"),
      );
    }, 1000);
  }
});

// Also supervise processes that survived a dashboard restart and are therefore
// no longer direct children of this Node process.
setInterval(async () => {
  if (shuttingDown) return;

  if (keepAlgoRunning && !(await isAlgoActuallyRunning())) {
    axios.post(`http://localhost:${PORT}/api/start-server`).catch((error) =>
      appendLifecycleLog(`Algo server health recovery failed: ${error.message}`, "error"),
    );
  }

  if (keepNgrokRunning) {
    const ngrokHealth = await getNgrokHealth();
    if (ngrokHealth.running && !ngrokHealth.duplicate) {
      clearNgrokRestartState();
    } else {
      scheduleNgrokRestart();
    }
  }
}, 15000).unref();

function markDashboardShutdown() {
  shuttingDown = true;
  keepAlgoRunning = false;
  keepNgrokRunning = false;
  clearAlgoOutageAlert();
  clearNgrokRestartState();
}

function shutdownDashboardProcess() {
  markDashboardShutdown();
  process.exit(0);
}

process.on("SIGINT", shutdownDashboardProcess);
process.on("SIGTERM", shutdownDashboardProcess);
