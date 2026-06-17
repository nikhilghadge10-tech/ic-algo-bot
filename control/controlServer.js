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

const envPath = path.join(__dirname, "..", ".env");
const axios = require("axios");

let algoProcess = null;
let ngrokProcess = null;
let ngrokUrl = "";
const logPath = path.join(__dirname, "..", "logs", "app.log");
const positionPath = path.join(__dirname, "..", "src", "data", "position.json");
const tradeStatePath = path.join(__dirname, "..", "src", "data", "tradeState.json");
const tradeHistoryPath = path.join(
  __dirname,
  "..",
  "src",
  "data",
  "tradeHistory.json",
);

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

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;

    const [key] = trimmed.split("=");

    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      return `${key}=${updates[key]}`;
    }

    return line;
  });

  fs.writeFileSync(envPath, updatedLines.join("\n"));
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

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
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

function getIstDaySeparator(date) {
  const { day, month, year } = getIstDateParts(date);
  return `\n==========================   ${Number(day)} - ${month} - ${year}   ============================\n`;
}

function getTradeSeparator(sequence) {
  return `---------------------------        Trade -${sequence}        ---------------------------`;
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
  return /(LONG_ENTRY|SHORT_ENTRY).*(ignored|failed)|daily trade limit reached/i.test(
    line,
  );
}

function isPositionChanged(line) {
  return /Position changed to (LONG|SHORT)/.test(line);
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

function formatDashboardLogs(content) {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return "No logs yet.";
  }

  const daysByKey = new Map();
  let currentTrade = null;
  let pendingTrade = null;

  lines.slice(-160).forEach((line) => {
    const parsedLine = getParsedLogLine(line);
    const day = getLogDay(daysByKey, parsedLine);
    day.latestMs = Math.max(day.latestMs, parsedLine.timestampMs);

    if (currentTrade && currentTrade.dateKey !== parsedLine.dateKey) {
      currentTrade = null;
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
        const trade = {
          sequence: pendingTrade.day.trades.length + 1,
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
  const env = readEnv();

  const algoRunning = await isAlgoActuallyRunning();
  const ngrokHealth = await getNgrokHealth();

  res.json({
    ALLOW_BUY: env.ALLOW_BUY,
    ALLOW_SELL: env.ALLOW_SELL,
    PAPER_TRADE: env.PAPER_TRADE,
    NO_TRADE_TODAY: env.NO_TRADE_TODAY,
    AUTO_PREMIUM_SL: env.AUTO_PREMIUM_SL,
    PREMIUM_SL_INTERVAL: env.PREMIUM_SL_INTERVAL,

    MAX_DAILY_TRADES: env.MAX_DAILY_TRADES,
    MAX_OPEN_POSITIONS: env.MAX_OPEN_POSITIONS,

    NUMBER_OF_LOTS: env.NUMBER_OF_LOTS,
    LOT_SIZE: env.LOT_SIZE,

    TRADING_CAPITAL: env.TRADING_CAPITAL,
    RISK_MODE: env.RISK_MODE,
    RISK_PERCENT: env.RISK_PERCENT,
    PLANNING_SL_POINTS: env.PLANNING_SL_POINTS,
    MARKET_BIAS: env.MARKET_BIAS,

    DHAN_TOKEN_UPDATED_AT: env.DHAN_TOKEN_UPDATED_AT,

    algoRunning,
    ngrokRunning: ngrokHealth.running,
    ngrokUrl: ngrokHealth.url,
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

// Ask ngrok's local API for the current public HTTPS tunnel.
async function getNgrokHealth() {
  try {
    const response = await axios.get("http://127.0.0.1:4040/api/tunnels", {
      timeout: 1500,
    });

    const tunnel = response.data.tunnels.find((t) => t.proto === "https");

    return {
      running: !!tunnel,
      url: tunnel ? tunnel.public_url + "/webhook" : "",
    };
  } catch (error) {
    return {
      running: false,
      url: "",
    };
  }
}

// Save dashboard-edited settings back to .env.
app.post("/api/config", (req, res) => {
  writeEnv(req.body);
  res.json({ success: true });
});

// Start the algo webhook server as a child process.
app.post("/api/start-server", async (req, res) => {
  if (algoProcess) {
    appendLifecycleLog("Algo server start requested but already running");
    return res.json({ success: true, message: "Algo server already running" });
  }

  if (await isAlgoActuallyRunning()) {
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
  });

  res.json({ success: true, message: "Algo server started" });
});

// Stop the child algo server if this dashboard started it.
app.post("/api/stop-server", (req, res) => {
  if (!algoProcess) {
    appendLifecycleLog("Algo server stop requested but dashboard has no child process");
    return res.json({ success: true, message: "Algo server not running" });
  }

  appendLifecycleLog("Algo server stop requested");
  algoProcess.kill();
  algoProcess = null;

  res.json({ success: true, message: "Algo server stopped" });
});

// Start ngrok so TradingView can reach the local webhook.
app.post("/api/start-ngrok", async (req, res) => {
  const health = await getNgrokHealth();

  if (health.running) {
    appendLifecycleLog(
      `Ngrok start requested but already running url=${health.url || "unknown"}`,
    );
    return res.json({
      success: true,
      message: "Ngrok already running",
    });
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
  });

  res.json({
    success: true,
    message: "Ngrok started",
  });
});

// Stop ngrok, including any process that may have been started separately.
app.post("/api/stop-ngrok", async (req, res) => {
  try {
    appendLifecycleLog("Ngrok stop requested");

    if (ngrokProcess) {
      ngrokProcess.kill();
      ngrokProcess = null;
    }

    // kill any existing ngrok process
    spawn("pkill", ["ngrok"], {
      shell: true,
    });

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

// Proxy the algo server status into the dashboard.
app.get("/api/algo-status", async (req, res) => {
  try {
    const response = await axios.get("http://localhost:3000/status", {
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

  try {
    appendLifecycleLog(`MANUAL_SIGNAL requested signal=${payload.signal || "unknown"}`);

    const response = await axios.post(
      "http://localhost:3000/webhook",
      payload,
      {
        timeout: 30000,
      },
    );

    res.json({
      success: true,
      message: `Test signal sent: ${payload.signal}`,
      response: response.data,
    });
    appendLifecycleLog(`MANUAL_SIGNAL completed signal=${payload.signal || "unknown"}`);
  } catch (error) {
    const afterSnapshot = await getAlgoSnapshot();

    if (didAlgoStateChange(beforeSnapshot, afterSnapshot)) {
      appendLifecycleLog(
        `MANUAL_SIGNAL response lost after processing signal=${payload.signal || "unknown"}: ${error.message}`,
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

    appendLifecycleLog(`MANUAL_SIGNAL failed: ${error.message}`, "warn");

    res.json({
      success: false,
      message: "Test signal failed. Is algo server running?",
      error: error.message,
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
    const lastLines = formatDashboardLogs(content);

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

// Fetch NIFTY spot LTP through the algo server for manual signal price prefill.
app.get("/api/nifty-spot", async (req, res) => {
  try {
    const response = await axios.get("http://localhost:3000/nifty-spot", {
      timeout: 5000,
    });

    res.json(response.data);
  } catch (error) {
    res.json({
      success: false,
      message: "NIFTY spot price unavailable",
      error: error.response?.data || error.message,
    });
  }
});

// Store a refreshed Dhan token and timestamp in .env.
app.post("/api/update-dhan-token", (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({
      success: false,
      message: "Token is required",
    });
  }

  writeEnv({
    DHAN_ACCESS_TOKEN: token,
    DHAN_TOKEN_UPDATED_AT: getIstIsoString(),
  });

  res.json({
    success: true,
    message: "Dhan token updated. Restart algo server.",
  });
});

// Start the local dashboard server.
app.listen(PORT, () => {
  appendLifecycleLog(`Control dashboard started on port ${PORT}`);
  console.log(`Control dashboard running at http://localhost:${PORT}`);
});
