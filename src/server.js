/*
 * Main algo webhook server.
 * Receives TradingView-style signals, selects the NIFTY option contract,
 * places Dhan market orders, tracks local position state, and sends Telegram
 * alerts. Runtime trading toggles are read from .env so the control panel can
 * change permissions without restarting this process.
 */
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const logger = require("./services/logger");
const express = require("express");
const {
  sendTelegram,
  sendTelegramAndWait,
  isTelegramEnabled,
} = require("./services/telegramService");
const { getProfile } = require("./services/dhanService");
const { loadPosition, savePosition } = require("./services/positionService");
const { getOptionDetails } = require("./services/optionSelector");
const {
  cancelOrder,
  getOrderStatus,
  placeMarketBuyOrder,
  placeMarketSellOrder,
  placeStopLossLimitSellOrder,
} = require("./services/dhanOrderService");

const { placeOrder, checkDhanHealth } = require("./services/dhanService");

const {
  loadInstruments,
  getNiftyOption,
} = require("./services/instrumentService");
const {
  getDailyTradeLimitStatus,
  normalizeTradeMode,
  recordSuccessfulEntry,
} = require("./services/tradeLimitService");
const {
  getNiftySpotLtp,
  getOptionLtp,
  getPreviousCompletedIntradayCandle,
} = require("./services/dhanMarketDataService");
const { calculateLots } = require("./services/riskService");
const {
  getDhanRuntimeConfig,
  normalizeDhanEnvironment,
} = require("./services/dhanRuntimeConfig");
const {
  createTrade,
  getDashboardTrades,
  markLatestOpenTradeExited,
  markTradeFailed,
  markTradeStopLossHit,
} = require("./services/tradeHistoryService");

const positionData = loadPosition();
const envPath = path.join(__dirname, "..", ".env");

// Restore open-position state first so exits after a restart still know what to sell.
let currentPosition = positionData.currentPosition;
let securityId = positionData.securityId;
let quantity = positionData.quantity;
let optionSymbol = positionData.optionSymbol;
let stopLossOrderId = positionData.stopLossOrderId;
let premiumStopLoss = positionData.premiumStopLoss;
let premiumStopLossCandle = positionData.premiumStopLossCandle;
let currentPositionMode = positionData.tradeMode || positionData.positionMode || null;

console.log(`Restored Position: ${currentPosition}`);
logger.info("LIFECYCLE Algo server process booting");

const app = express();
let lastSignal = "";
let lastSignalTime = 0;
let server = null;
const recentWebhookSignals = new Map();
const WEBHOOK_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

// All incoming webhook/control payloads are JSON.
app.use(express.json());

// Basic liveness route for quick browser/terminal checks.
app.get("/", (req, res) => {
  res.send("IC Algo Bot Running");
});

// Manual Telegram smoke test.
app.get("/test", async (req, res) => {
  if (!isTelegramEnabled()) {
    return res.status(200).send("Telegram is disabled");
  }

  try {
    await sendTelegramAndWait("🚀 IC Algo Bot Telegram Test Successful");

    res.send("Telegram sent");
  } catch (error) {
    console.error(error);

    res.status(500).send("Telegram failed");
  }
});

// Manual Dhan credential test.
app.get("/dhan-test", async (req, res) => {
  try {
    const profile = await getProfile();

    console.log(profile);

    res.json(profile);
  } catch (error) {
    console.error(error);

    res.status(500).send("Dhan connection failed");
  }
});

const PORT = process.env.PORT || 3000;

// Load the option master file into memory before webhook traffic arrives.
loadInstruments();

// Dashboard status endpoint. Config is read live so toggles update immediately.
app.get("/status", async (req, res) => {
  const config = getRuntimeConfig();
  const statusConfig = {
    ...config,
    PAPER_TRADE:
      req.query.paperTrade === "true" || req.query.paperTrade === "false"
        ? req.query.paperTrade
        : config.PAPER_TRADE,
  };

  await syncActiveStopLossStatus();

  const activeTradeMode = getTradeMode(statusConfig);
  const positionBelongsToActiveMode =
    currentPosition && normalizeTradeMode(currentPositionMode) === activeTradeMode;

  res.json({
    currentPosition: positionBelongsToActiveMode ? currentPosition : null,
    lastSignal,
    lastSignalTime,
    allowBuy: statusConfig.ALLOW_BUY,
    allowSell: statusConfig.ALLOW_SELL,
    paperTrade: statusConfig.PAPER_TRADE,
    dhanEnvironment: normalizeDhanEnvironment(statusConfig.DHAN_ENV),
    tradeMode: activeTradeMode,
    storedPositionMode: currentPosition ? normalizeTradeMode(currentPositionMode) : null,
    lotSize: statusConfig.LOT_SIZE,
    optionMode: statusConfig.OPTION_MODE,
    dailyTradeLimit: getDailyTradeLimitStatus(
      statusConfig.MAX_DAILY_TRADES,
      activeTradeMode,
    ),
    lastTrades: getDashboardTrades(
      3,
      activeTradeMode,
      statusConfig.PREMIUM_SL_INTERVAL,
    ),
    autoPremiumSl: statusConfig.AUTO_PREMIUM_SL,
    premiumSlInterval: statusConfig.PREMIUM_SL_INTERVAL,
    premiumSlLimitBand: statusConfig.PREMIUM_SL_LIMIT_BAND,
  });
});

// Merge process env with the latest .env file values written by the dashboard.
function getRuntimeConfig() {
  try {
    const envFile = fs.readFileSync(envPath);
    return {
      ...process.env,
      ...dotenv.parse(envFile),
    };
  } catch (error) {
    logger.warn(`Unable to read runtime config: ${error.message}`);
    return process.env;
  }
}

// Normalize string/boolean-style feature flags to a strict true check.
function isEnabled(value) {
  return String(value).toLowerCase() === "true";
}

function getTradeMode(config) {
  if (isEnabled(config.PAPER_TRADE)) {
    return "PAPER";
  }

  return normalizeDhanEnvironment(config.DHAN_ENV);
}

function currentPositionBelongsToMode(mode) {
  return currentPosition && normalizeTradeMode(currentPositionMode) === mode;
}

function isAllowedUnderlyingSymbol(symbol) {
  const normalized = String(symbol || "")
    .toUpperCase()
    .replace(/^.*:/, "")
    .replace(/[^A-Z0-9]/g, "");

  return normalized === "NIFTY" || normalized === "NIFTY50";
}

function getWebhookDedupeKey({ signal, symbol, time }) {
  if (!signal || !symbol || !time) {
    return "";
  }

  const normalizedSymbol = String(symbol)
    .toUpperCase()
    .replace(/^.*:/, "")
    .replace(/[^A-Z0-9]/g, "");

  return `${String(signal).toUpperCase()}|${normalizedSymbol}|${String(time)}`;
}

function isDuplicateWebhook(payload, now = Date.now()) {
  const key = getWebhookDedupeKey(payload);

  for (const [storedKey, receivedAt] of recentWebhookSignals) {
    if (now - receivedAt > WEBHOOK_DEDUPE_WINDOW_MS) {
      recentWebhookSignals.delete(storedKey);
    }
  }

  if (!key) {
    return false;
  }

  const previousReceivedAt = recentWebhookSignals.get(key);

  if (
    previousReceivedAt !== undefined &&
    now - previousReceivedAt <= WEBHOOK_DEDUPE_WINDOW_MS
  ) {
    return true;
  }

  recentWebhookSignals.set(key, now);
  return false;
}

function normalizeAlertIntervalMinutes(value, fallback = 15) {
  if (value === undefined || value === null || value === "") {
    return Number(fallback || 15);
  }

  const text = String(value).trim().toLowerCase();
  const numeric = Number(text);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const match = text.match(/^(\d+(?:\.\d+)?)(m|min|minute|minutes|h|hr|hour|hours)$/);

  if (!match) {
    return Number(fallback || 15);
  }

  const amount = Number(match[1]);
  const unit = match[2];

  if (!Number.isFinite(amount) || amount <= 0) {
    return Number(fallback || 15);
  }

  if (["h", "hr", "hour", "hours"].includes(unit)) {
    return amount * 60;
  }

  return amount;
}

// Shared response for disabled BUY/SELL permission gates.
async function rejectDisabledEntry(res, signal, symbol, price, permissionName) {
  logger.warn(`${signal} ignored because ${permissionName} is disabled`);

  await sendTelegram(
    `⚠️ ${signal} ignored

${permissionName} is OFF.

Symbol : ${symbol}
Price  : ${price}

No order placed.`,
  );

  return res.status(200).send(`${permissionName} disabled\n`);
}

// Shared response when today's successful entry count reaches MAX_DAILY_TRADES.
async function rejectDailyTradeLimit(res, signal, symbol, price, limitStatus) {
  logger.warn(
    `${signal} ignored because daily trade limit reached: ${limitStatus.entryCount}/${limitStatus.limit}`,
  );

  await sendTelegram(
    `⚠️ Daily Trade Limit Reached

Signal : ${signal}
Symbol : ${symbol}
Price  : ${price}

Trades Today : ${limitStatus.entryCount}/${limitStatus.limit}
Date : ${limitStatus.date}

No order placed.`,
  );

  return res.status(200).send("Daily trade limit reached\n");
}

function isEntrySignal(signal) {
  return signal === "LONG_ENTRY" || signal === "SHORT_ENTRY";
}

function getOrderId(orderResult) {
  return orderResult?.data?.orderId || orderResult?.data?.order_id || null;
}

function getBrokerOrderStatus(orderStatusResult) {
  const data = orderStatusResult?.data;
  const order = Array.isArray(data) ? data[0] : data;

  return String(
    order?.orderStatus ||
      order?.order_status ||
      order?.status ||
      "",
  ).toUpperCase();
}

function isBrokerOrderExecuted(orderStatus) {
  return [
    "TRADED",
    "EXECUTED",
    "FILLED",
    "COMPLETE",
    "COMPLETED",
  ].includes(orderStatus);
}

function getBrokerOrderRecord(orderStatusResult) {
  const data = orderStatusResult?.data;
  return Array.isArray(data) ? data[0] : data;
}

function getBrokerOrderFailureReason(orderStatusResult) {
  const order = getBrokerOrderRecord(orderStatusResult);

  return (
    order?.omsErrorDescription ||
    order?.errorDescription ||
    order?.message ||
    `Order status: ${getBrokerOrderStatus(orderStatusResult) || "UNKNOWN"}`
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function confirmEntryOrderExecution(orderResult) {
  if (orderResult.paperTrade) {
    return {
      success: true,
      paperTrade: true,
      status: "PAPER_FILLED",
    };
  }

  const orderId = getOrderId(orderResult);

  if (!orderId) {
    return {
      success: false,
      error: "Dhan accepted the request without returning an order ID",
    };
  }

  let latestStatusResult = null;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) {
      await delay(250);
    }

    latestStatusResult = await getOrderStatus(orderId);

    if (!latestStatusResult.success) {
      continue;
    }

    const status = getBrokerOrderStatus(latestStatusResult);

    if (isBrokerOrderExecuted(status)) {
      return {
        success: true,
        orderId,
        status,
        order: getBrokerOrderRecord(latestStatusResult),
      };
    }

    if (["REJECTED", "CANCELLED", "EXPIRED"].includes(status)) {
      return {
        success: false,
        orderId,
        status,
        error: getBrokerOrderFailureReason(latestStatusResult),
      };
    }
  }

  logger.warn(`Entry order ${orderId} was not confirmed; attempting cancellation`);
  await cancelOrder(orderId);
  latestStatusResult = await getOrderStatus(orderId);

  if (
    latestStatusResult.success &&
    isBrokerOrderExecuted(getBrokerOrderStatus(latestStatusResult))
  ) {
    return {
      success: true,
      orderId,
      status: getBrokerOrderStatus(latestStatusResult),
      order: getBrokerOrderRecord(latestStatusResult),
    };
  }

  return {
    success: false,
    orderId,
    status: latestStatusResult?.success
      ? getBrokerOrderStatus(latestStatusResult)
      : "UNCONFIRMED",
    error: latestStatusResult?.success
      ? getBrokerOrderFailureReason(latestStatusResult)
      : "Entry order could not be confirmed and was cancelled for safety",
  };
}

function getExecutedPrice(entryConfirmation, fallbackPrice) {
  const order = entryConfirmation?.order;
  const price = Number(
    order?.averageTradedPrice ||
      order?.tradedPrice ||
      order?.price ||
      fallbackPrice ||
      0,
  );

  return Number.isFinite(price) ? price : 0;
}

function getMinimumPremiumSlPoints(config) {
  const configured = Number(config.MIN_PREMIUM_SL_POINTS || 5);
  return Number.isFinite(configured) && configured > 0 ? configured : 5;
}

async function confirmProtectiveStopLoss(
  stopLossResult,
  expectedTriggerPrice,
  expectedLimitPrice,
) {
  if (!stopLossResult || !stopLossResult.success) {
    return {
      success: false,
      error: stopLossResult?.error || "Stop-loss order placement failed",
    };
  }

  if (stopLossResult.paperTrade) {
    return {
      success: true,
      protected: true,
      paperTrade: true,
      orderId: getOrderId(stopLossResult),
      status: "PENDING",
      triggerPrice: expectedTriggerPrice,
      limitPrice: expectedLimitPrice,
    };
  }

  const orderId = getOrderId(stopLossResult);

  if (!orderId) {
    return {
      success: false,
      error: "Dhan did not return a stop-loss order ID",
    };
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) {
      await delay(150);
    }

    const statusResult = await getOrderStatus(orderId);

    if (!statusResult.success) {
      continue;
    }

    const status = getBrokerOrderStatus(statusResult);
    const order = getBrokerOrderRecord(statusResult);

    if (isBrokerOrderExecuted(status)) {
      return {
        success: true,
        protected: false,
        executedImmediately: true,
        orderId,
        status,
        order,
      };
    }

    if (["REJECTED", "CANCELLED", "EXPIRED"].includes(status)) {
      return {
        success: false,
        orderId,
        status,
        error: getBrokerOrderFailureReason(statusResult),
      };
    }

    if (["PENDING", "TRANSIT"].includes(status)) {
      const reportedTrigger = Number(order?.triggerPrice || 0);
      const reportedLimit = Number(order?.price || 0);
      const orderType = String(order?.orderType || "").toUpperCase();
      const triggerMatches =
        Math.abs(reportedTrigger - Number(expectedTriggerPrice)) < 0.011;
      const limitMatches =
        Math.abs(reportedLimit - Number(expectedLimitPrice)) < 0.011;

      if (orderType === "STOP_LOSS" && triggerMatches && limitMatches) {
        return {
          success: true,
          protected: true,
          orderId,
          status,
          triggerPrice: reportedTrigger,
          limitPrice: reportedLimit,
          order,
        };
      }

      return {
        success: false,
        orderId,
        status,
        error:
          `Unexpected SL order: type=${orderType || "UNKNOWN"} ` +
          `trigger=${reportedTrigger || "missing"} expectedTrigger=${expectedTriggerPrice} ` +
          `limit=${reportedLimit || "missing"} expectedLimit=${expectedLimitPrice}`,
      };
    }
  }

  return {
    success: false,
    orderId,
    status: "UNCONFIRMED",
    error: "Stop-loss order could not be verified as pending",
  };
}

async function getExecutedStopLossAfterCancel(orderId) {
  if (!orderId) {
    return null;
  }

  const statusResult = await getOrderStatus(orderId);

  if (
    statusResult.success &&
    isBrokerOrderExecuted(getBrokerOrderStatus(statusResult))
  ) {
    return {
      orderId,
      status: getBrokerOrderStatus(statusResult),
      order: getBrokerOrderRecord(statusResult),
    };
  }

  return null;
}

async function exitUnprotectedEntry(securityIdToExit, quantityToExit) {
  const exitResult = await placeMarketSellOrder(
    securityIdToExit,
    quantityToExit,
  );

  if (!exitResult.success) {
    return {
      success: false,
      error: exitResult.error || "Emergency exit order placement failed",
    };
  }

  return confirmEntryOrderExecution(exitResult);
}

async function handleUnsafeFilledEntry({
  signal,
  activeTradeMode,
  contract,
  quantity: entryQuantity,
  entryOrderId,
  entryFillPrice,
  riskPlan,
  sizing,
  reason,
}) {
  logger.error(`${signal} safety exit requested: ${reason}`);
  const exitConfirmation = await exitUnprotectedEntry(
    contract.SEM_SMST_SECURITY_ID,
    entryQuantity,
  );

  const trade = createTrade({
    signal,
    tradeMode: activeTradeMode,
    entryOrderId,
    securityId: contract.SEM_SMST_SECURITY_ID,
    quantity: entryQuantity,
    optionSymbol: contract.SEM_CUSTOM_SYMBOL,
    stopLossOrderId: null,
    premiumStopLoss: riskPlan.stopLossPremium,
    premiumStopLossCandle: null,
    entryPremiumReference: entryFillPrice,
    riskPoints: Number(
      (entryFillPrice - Number(riskPlan.stopLossPremium || 0)).toFixed(2),
    ),
    riskSource: "ACTUAL_FILL",
  });

  recordSuccessfulEntry(activeTradeMode);

  if (exitConfirmation.success) {
    markTradeFailed(
      entryOrderId,
      `${reason}; safety exit order ${exitConfirmation.orderId || "confirmed"}`,
    );
    clearOpenPosition();
    return {
      success: true,
      exited: true,
      trade,
      exitConfirmation,
    };
  }

  currentPosition = signal === "LONG_ENTRY" ? "LONG" : "SHORT";
  currentPositionMode = activeTradeMode;
  securityId = contract.SEM_SMST_SECURITY_ID;
  quantity = entryQuantity;
  optionSymbol = contract.SEM_CUSTOM_SYMBOL;
  stopLossOrderId = null;
  premiumStopLoss = riskPlan.stopLossPremium || null;
  premiumStopLossCandle = null;

  savePosition({
    currentPosition,
    tradeMode: currentPositionMode,
    securityId,
    quantity,
    optionSymbol,
    stopLossOrderId,
    premiumStopLoss,
    premiumStopLossCandle,
    entryPremiumReference: entryFillPrice,
    riskPoints: sizing.riskPoints,
    riskSource: "ACTUAL_FILL",
  });

  return {
    success: false,
    exited: false,
    trade,
    exitConfirmation,
  };
}

function clearOpenPosition() {
  currentPosition = null;
  currentPositionMode = null;
  securityId = null;
  quantity = null;
  optionSymbol = null;
  stopLossOrderId = null;
  premiumStopLoss = null;
  premiumStopLossCandle = null;
  savePosition({
    currentPosition,
    tradeMode: currentPositionMode,
    securityId,
    quantity,
    optionSymbol,
    stopLossOrderId,
    premiumStopLoss,
    premiumStopLossCandle,
  });
}

async function syncActiveStopLossStatus() {
  if (!stopLossOrderId || !currentPosition) {
    return;
  }

  const trackedStopLossOrderId = stopLossOrderId;

  const result = await getOrderStatus(trackedStopLossOrderId);

  if (!result.success) {
    logger.warn(
      `Unable to sync stop-loss order status: ${JSON.stringify(result.error)}`,
    );
    return;
  }

  const orderStatus = getBrokerOrderStatus(result);

  if (!isBrokerOrderExecuted(orderStatus)) {
    return;
  }

  logger.info(`Premium stop-loss hit: ${trackedStopLossOrderId}`);
  markTradeStopLossHit(trackedStopLossOrderId);
  clearOpenPosition();
}

function normalizeTickSize(tickSize) {
  const parsedTick = Number(tickSize || 0);

  if (!parsedTick) {
    return 0.05;
  }

  return parsedTick >= 1 ? parsedTick / 100 : parsedTick;
}

function roundToTick(price, tickSize) {
  const tick = normalizeTickSize(tickSize);
  return Number((Math.round(Number(price) / tick) * tick).toFixed(2));
}

function getHugePremiumCandleThreshold(interval, config) {
  const defaults = {
    1: 6,
    3: 12,
    5: 15,
    15: 25,
  };
  const configKey = {
    1: "PREMIUM_HUGE_CANDLE_1M",
    3: "PREMIUM_HUGE_CANDLE_3M",
    5: "PREMIUM_HUGE_CANDLE_5M",
    15: "PREMIUM_HUGE_CANDLE_15M",
  }[Number(interval)];

  if (!configKey) {
    return null;
  }

  const configured = Number(config[configKey]);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : defaults[Number(interval)];
}

async function getPremiumStopLossPlan(
  contract,
  config,
  referenceTime,
  alertInterval,
) {
  if (!isEnabled(config.AUTO_PREMIUM_SL)) {
    return null;
  }

  const interval = normalizeAlertIntervalMinutes(
    alertInterval,
    config.PREMIUM_SL_INTERVAL || 15,
  );
  const result = await getPreviousCompletedIntradayCandle(
    contract,
    interval,
    referenceTime,
  );

  if (!result.candle) {
    return {
      success: false,
      error: "Previous premium candle not found",
      request: result.payload,
    };
  }

  const candleLow = Number(result.candle.low);
  const candleHigh = Number(result.candle.high);
  const candleRange = Number((candleHigh - candleLow).toFixed(2));
  const hugeCandleThreshold = getHugePremiumCandleThreshold(interval, config);
  const hugeCandleAdjusted =
    Number.isFinite(candleRange) &&
    hugeCandleThreshold !== null &&
    candleRange > hugeCandleThreshold;
  const rawTriggerPrice = roundToTick(candleLow, contract.SEM_TICK_SIZE);
  const triggerPrice = roundToTick(
    hugeCandleAdjusted ? candleLow + candleRange / 2 : candleLow,
    contract.SEM_TICK_SIZE,
  );
  const configuredBand = Number(config.PREMIUM_SL_LIMIT_BAND || 1);
  const limitBand =
    Number.isFinite(configuredBand) && configuredBand > 0
      ? configuredBand
      : 1;
  const limitPrice = roundToTick(
    triggerPrice - limitBand,
    contract.SEM_TICK_SIZE,
  );

  if (
    !triggerPrice ||
    triggerPrice <= 0 ||
    !limitPrice ||
    limitPrice <= 0 ||
    limitPrice >= triggerPrice
  ) {
    return {
      success: false,
      error:
        `Invalid premium stop-loss prices: trigger=${triggerPrice} ` +
        `limit=${limitPrice} band=${limitBand}`,
      candle: result.candle,
      request: result.payload,
    };
  }

  logger.info(
    `Premium SL-Limit plan: securityId=${contract.SEM_SMST_SECURITY_ID} ` +
      `interval=${interval} candleLow=${candleLow} candleHigh=${candleHigh} ` +
      `candleRange=${candleRange} hugeThreshold=${hugeCandleThreshold ?? "n/a"} ` +
      `halfCandle=${hugeCandleAdjusted} rawTrigger=${rawTriggerPrice} ` +
      `trigger=${triggerPrice} limit=${limitPrice} band=${limitBand}`,
  );

  return {
    success: true,
    rawTriggerPrice,
    triggerPrice,
    limitPrice,
    limitBand,
    interval,
    candleRange,
    hugeCandleThreshold,
    hugeCandleAdjusted,
    candle: {
      timestamp: result.candle.timestamp,
      time: result.candle.time.toISOString(),
      open: result.candle.open,
      high: result.candle.high,
      low: result.candle.low,
      close: result.candle.close,
    },
    request: result.payload,
  };
}

async function rejectPremiumStopLossFailure(res, signal, symbol, price, result) {
  logger.warn(
    `${signal} ignored because premium stop-loss setup failed: ${JSON.stringify(
      result.error || result,
    )}`,
  );

  await sendTelegram(
    `❌ Premium Stop Loss Setup Failed

Signal : ${signal}
Symbol : ${symbol}
Price  : ${price}

Reason:
${JSON.stringify(result.error || result, null, 2)}

No entry order placed.`,
  );

  return res.status(200).send("Premium stop loss setup failed\n");
}

function getEntrySizing(signal, config, riskPoints) {
  return calculateLots({
    signal,
    riskPoints,
    settings: config,
  });
}

async function getEntryRiskPlan(contract, config, stopLossPlan) {
  if (!stopLossPlan) {
    return {
      success: true,
      source: "TENTATIVE_SL",
      riskPoints: Number(config.PLANNING_SL_POINTS || 0),
      entryPremium: null,
      stopLossPremium: null,
    };
  }

  try {
    const optionQuote = await getOptionLtp(contract);
    const entryPremium = Number(optionQuote.ltp);
    const stopLossPremium = Number(stopLossPlan.triggerPrice);
    const riskPoints = Number((entryPremium - stopLossPremium).toFixed(2));

    if (!Number.isFinite(riskPoints) || riskPoints <= 0) {
      return {
        success: false,
        error:
          `Option LTP ${entryPremium} must be above premium SL ${stopLossPremium}`,
        entryPremium,
        stopLossPremium,
      };
    }

    return {
      success: true,
      source: "LIVE_PREMIUM",
      riskPoints,
      entryPremium,
      stopLossPremium,
      checkedAt: optionQuote.checkedAt,
    };
  } catch (error) {
    return {
      success: false,
      error: `Unable to fetch selected option LTP: ${error.message}`,
    };
  }
}

async function rejectInvalidEntrySize(res, signal, symbol, price, sizing) {
  logger.warn(`${signal} ignored because calculated quantity is invalid`);

  await sendTelegram(
    `⚠️ ${signal} ignored

Calculated lots are zero or invalid.

Symbol : ${symbol}
Price  : ${price}

Risk Amount : ${sizing.riskAmount}
Loss Per Lot : ${sizing.lossPerLot}
Lots : ${sizing.finalLots}
Quantity : ${sizing.quantity}

No order placed.`,
  );

  return res.status(200).send("Invalid calculated quantity\n");
}

async function placeProtectiveStopLoss(contract, entryQuantity, stopLossPlan) {
  if (!stopLossPlan) {
    return {
      success: true,
      skipped: true,
    };
  }

  return placeStopLossLimitSellOrder(
    contract.SEM_SMST_SECURITY_ID,
    entryQuantity,
    stopLossPlan.triggerPrice,
    stopLossPlan.limitPrice,
  );
}

function shouldIgnoreTradingViewExit(config) {
  return isEnabled(config.AUTO_PREMIUM_SL) && !!stopLossOrderId;
}

async function cancelProtectiveStopLossForTradingViewExit(
  signal,
  exitOptionSymbol,
) {
  if (!stopLossOrderId) {
    return {
      success: true,
      skipped: true,
    };
  }

  const cancelResult = await cancelOrder(stopLossOrderId);

  if (!cancelResult.success) {
    await sendTelegram(
      `❌ ${signal} blocked

Could not cancel existing protective stop-loss order.

Contract :
${exitOptionSymbol}

Stop Loss Order ID :
${stopLossOrderId}

Reason:
${JSON.stringify(cancelResult.error, null, 2)}

Market exit order NOT placed.`,
    );
  }

  return cancelResult;
}

async function ignoreTradingViewExit(
  res,
  signal,
  symbol,
  price,
  exitOptionSymbol,
) {
  logger.warn(`${signal} ignored because premium stop-loss is active`);

  await sendTelegram(
    `⚠️ ${signal} ignored

Premium stop-loss is active, so TradingView exit signals are ignored.

Symbol : ${symbol}
Price  : ${price}

Contract :
${exitOptionSymbol}

Stop Loss Order ID :
${stopLossOrderId}

Premium SL :
${premiumStopLoss || "-"}

No market exit order placed.`,
  );

  return res.status(200).send("TradingView exit ignored; premium SL active\n");
}

// Pick a Telegram emoji based on the signal type.
function getSignalEmoji(signal) {
  switch (signal) {
    case "LONG_ENTRY":
      return "🚀";

    case "LONG_EXIT":
      return "✅";

    case "SHORT_ENTRY":
      return "🔻";

    case "SHORT_EXIT":
      return "☑️";

    default:
      return "ℹ️";
  }
}

function getTradeModeLabel(config, action) {
  return `${getTradeMode(config)} ${action}`;
}

function getOrderPlacementNote(config) {
  return isEnabled(config.PAPER_TRADE)
    ? "No real order placed."
    : "Real order placed on Dhan.";
}

// Main trading webhook. Signals are validated, gated, converted to contracts,
// sent to Dhan, and then reflected in local position state only after success.
app.post("/webhook", async (req, res) => {
  console.log("Webhook Position =", currentPosition);

  try {
    logger.info(`Webhook received: ${JSON.stringify(req.body)}`);

    const { signal, source, symbol, price, time, interval, timeframe } = req.body;
    const alertInterval = interval || timeframe;
    const manualSignal =
      String(source || "").toUpperCase() === "MANUAL_SIGNAL";

    // Reject malformed signals before any trading logic can run.
    if (!signal || !symbol || !price) {
      logger.warn(`Invalid webhook payload: ${JSON.stringify(req.body)}`);

      await sendTelegram(
        `❌ Invalid Webhook Payload

Received:
${JSON.stringify(req.body, null, 2)}

No order placed.`,
      );

      return res.status(400).send("Invalid payload");
    }

    if (!isAllowedUnderlyingSymbol(symbol)) {
      logger.warn(`Webhook ignored because symbol is not NIFTY: ${symbol}`);

      await sendTelegram(
        `⚠️ Non-NIFTY Signal Ignored

Signal : ${signal}
Symbol : ${symbol}
Price  : ${price}

Only NIFTY alerts are allowed.

No order placed.`,
      );

      return res.status(200).send("Non-NIFTY symbol ignored\n");
    }

    if (isDuplicateWebhook({ signal, symbol, time })) {
      logger.warn(
        `Duplicate webhook ignored: signal=${signal} symbol=${symbol} time=${time}`,
      );
      return res.status(200).send("Duplicate webhook ignored\n");
    }

    lastSignal = signal;
    lastSignalTime = time || new Date().toISOString();

    logger.info(`Last Signal Updated: ${signal}`);
    const config = getRuntimeConfig();
    const activeTradeMode = getTradeMode(config);
    const effectiveInterval = normalizeAlertIntervalMinutes(
      alertInterval,
      config.PREMIUM_SL_INTERVAL || 15,
    );
    const dhanEnvironment = normalizeDhanEnvironment(config.DHAN_ENV);
    const orderRoute =
      activeTradeMode === "PAPER" ? "SIMULATION" : `${dhanEnvironment}_DHAN`;

    logger.info(
      `Execution context: tradeMode=${activeTradeMode} orderRoute=${orderRoute} ` +
        `dhanEnvironment=${dhanEnvironment} marketData=LIVE interval=${effectiveInterval}`,
    );

    if (activeTradeMode !== "PAPER") {
      const dhan = getDhanRuntimeConfig();

      if (!dhan.configured) {
        logger.warn(
          `${signal} ignored because ${dhan.environment} Dhan credentials are missing`,
        );
        return res
          .status(200)
          .send(`${dhan.environment} Dhan credentials are not configured\n`);
      }
    }

    // Global kill switch: useful for market holidays or manual pauses.
    if (isEnabled(config.NO_TRADE_TODAY)) {
      await sendTelegram(
        `⚠️ Trading Disabled Today

Signal : ${signal}

Symbol : ${symbol}

Price : ${price}

No order placed.`,
      );

      return res.status(200).send("Trading disabled\n");
    }

    const emoji = getSignalEmoji(signal);

    // Entry permission gates are live toggles controlled from the dashboard.
    if (signal === "LONG_ENTRY" && !isEnabled(config.ALLOW_BUY)) {
      return rejectDisabledEntry(res, signal, symbol, price, "ALLOW_BUY");
    }

    if (signal === "SHORT_ENTRY" && !isEnabled(config.ALLOW_SELL)) {
      return rejectDisabledEntry(res, signal, symbol, price, "ALLOW_SELL");
    }

    // Daily trade limit counts only successful entries and resets by IST date.
    if (isEntrySignal(signal)) {
      const limitStatus = getDailyTradeLimitStatus(
        config.MAX_DAILY_TRADES,
        activeTradeMode,
      );

      if (!limitStatus.allowed) {
        return rejectDailyTradeLimit(res, signal, symbol, price, limitStatus);
      }
    }

    switch (signal) {
      //  =============================== LONG ENTRY ===============================
      case "LONG_ENTRY": {
        // Ignore duplicate entries so one signal cannot stack multiple positions.
        if (
          currentPosition === "LONG" &&
          currentPositionBelongsToMode(activeTradeMode)
        ) {
          logger.warn("Duplicate LONG_ENTRY ignored");

          await sendTelegram(
            `⚠️ Duplicate LONG ignored

Already in LONG position.

Symbol : ${symbol}
Price : ${price}

No order placed.`,
          );

          return res.status(200).send("Duplicate ignored");
        }
        try {
          // This bot currently allows only one open position at a time.
          if (currentPosition !== null) {
            await sendTelegram(
              `⚠️ LONG_ENTRY ignored

Current Position : ${currentPosition}
Position Mode    : ${normalizeTradeMode(currentPositionMode)}
Signal Mode      : ${activeTradeMode}`,
            );

            return res.status(200).send("Position already open");
          }

          const option = getOptionDetails(signal, price);

          // Convert signal direction and spot price into a tradable NIFTY contract.
          const contract = getNiftyOption(option.strike, option.optionType);

          if (!contract) {
            logger.error("No matching option contract found");

            await sendTelegram(
              `❌ Contract Not Found

Signal : ${signal}
Symbol : ${symbol}
Price  : ${price}

No matching NIFTY option contract found.

No order placed.`,
            );

            return res.status(200).send("Contract not found");
          }

          logger.info(
            `Selected Contract: ${contract.SEM_CUSTOM_SYMBOL} securityId=${contract.SEM_SMST_SECURITY_ID} expiry=${contract.SEM_EXPIRY_DATE}`,
          );

          const stopLossPlan = await getPremiumStopLossPlan(
            contract,
            config,
            time,
            alertInterval,
          );

          if (stopLossPlan && !stopLossPlan.success) {
            return rejectPremiumStopLossFailure(
              res,
              signal,
              symbol,
              price,
              stopLossPlan,
            );
          }

          const riskPlan = await getEntryRiskPlan(
            contract,
            config,
            stopLossPlan,
          );

          if (!riskPlan.success) {
            return rejectPremiumStopLossFailure(
              res,
              signal,
              symbol,
              price,
              riskPlan,
            );
          }

          const minimumPremiumSlPoints =
            getMinimumPremiumSlPoints(config);

          if (
            stopLossPlan &&
            riskPlan.riskPoints < minimumPremiumSlPoints
          ) {
            return rejectPremiumStopLossFailure(
              res,
              signal,
              symbol,
              price,
              {
                error:
                  `Premium SL distance ${riskPlan.riskPoints} is below minimum ` +
                  `${minimumPremiumSlPoints}`,
                entryPremium: riskPlan.entryPremium,
                stopLossPremium: riskPlan.stopLossPremium,
              },
            );
          }

          const sizing = getEntrySizing(
            signal,
            config,
            riskPlan.riskPoints,
          );

          logger.info(
            `Entry sizing: source=${riskPlan.source} premium=${riskPlan.entryPremium ?? "n/a"} premiumSL=${riskPlan.stopLossPremium ?? "n/a"} candleLow=${stopLossPlan?.candle?.low ?? "n/a"} candleHigh=${stopLossPlan?.candle?.high ?? "n/a"} candleRange=${stopLossPlan?.candleRange ?? "n/a"} halfCandle=${stopLossPlan?.hugeCandleAdjusted ?? false} hugeThreshold=${stopLossPlan?.hugeCandleThreshold ?? "n/a"} riskPoints=${sizing.riskPoints} riskAmount=${sizing.riskAmount} lossPerLot=${sizing.lossPerLot} baseLots=${sizing.lots} lots=${sizing.finalLots} quantity=${sizing.quantity}`,
          );

          if (!sizing.quantity || sizing.quantity <= 0) {
            return rejectInvalidEntrySize(res, signal, symbol, price, sizing);
          }

          quantity = sizing.quantity;

          // Cache contract details in memory so the matching exit can sell them.
          securityId = contract.SEM_SMST_SECURITY_ID;
          optionSymbol = contract.SEM_CUSTOM_SYMBOL;

          console.log(contract);

          logger.info(`Selected Option: ${option.strike} ${option.optionType}`);

          console.log("ORDER CONTRACT");
          console.log(contract);

          const orderResult = await placeMarketBuyOrder(contract, quantity);

          console.log(orderResult);

          // Only mark position open after Dhan/paper order reports success.
          if (!orderResult.success) {
            await sendTelegram(
              `❌ LONG_ENTRY failed

Symbol : ${symbol}
Price  : ${price}

Reason:
${JSON.stringify(orderResult.error, null, 2)}

Position NOT changed.`,
            );

            return res.status(200).send("LONG_ENTRY failed\n");
          }

          const entryConfirmation =
            await confirmEntryOrderExecution(orderResult);

          if (!entryConfirmation.success) {
            logger.error(
              `LONG_ENTRY broker order not filled: ${entryConfirmation.error}`,
            );
            sendTelegram(
              `❌ LONG_ENTRY rejected by Dhan

Symbol : ${symbol}
Price  : ${price}
Order ID : ${entryConfirmation.orderId || "-"}
Status : ${entryConfirmation.status || "UNKNOWN"}

Reason:
${entryConfirmation.error}

Position NOT changed.`,
            );

            return res.status(200).send("LONG_ENTRY broker order not filled\n");
          }

          const actualEntryFillPrice = getExecutedPrice(
            entryConfirmation,
            riskPlan.entryPremium,
          );
          const actualRiskPoints = Number(
            (
              actualEntryFillPrice -
              Number(stopLossPlan?.triggerPrice || 0)
            ).toFixed(2),
          );

          logger.info(
            `LONG_ENTRY actual fill: premium=${actualEntryFillPrice} premiumSL=${stopLossPlan?.triggerPrice ?? "n/a"} riskPoints=${actualRiskPoints}`,
          );

          if (
            stopLossPlan &&
            actualRiskPoints < minimumPremiumSlPoints
          ) {
            const safetyResult = await handleUnsafeFilledEntry({
              signal,
              activeTradeMode,
              contract,
              quantity,
              entryOrderId: entryConfirmation.orderId,
              entryFillPrice: actualEntryFillPrice,
              riskPlan,
              sizing,
              reason:
                `Actual fill-to-SL distance ${actualRiskPoints} is below minimum ` +
                `${minimumPremiumSlPoints}`,
            });

            sendTelegram(
              safetyResult.exited
                ? `⚠️ LONG_ENTRY immediately exited for safety\n\nActual Fill : ${actualEntryFillPrice}\nPremium SL : ${stopLossPlan.triggerPrice}\nDistance : ${actualRiskPoints}\nMinimum : ${minimumPremiumSlPoints}`
                : `🚨 LONG_ENTRY is OPEN and UNPROTECTED\n\nSafety exit failed: ${safetyResult.exitConfirmation.error}`,
            );

            return res
              .status(200)
              .send(
                safetyResult.exited
                  ? "LONG_ENTRY safety exited\n"
                  : "LONG_ENTRY safety exit failed\n",
              );
          }

          currentPosition = "LONG";
          currentPositionMode = activeTradeMode;

          logger.info("Position changed to LONG");

          const stopLossResult = await placeProtectiveStopLoss(
            contract,
            quantity,
            stopLossPlan,
          );

          const slVerification = stopLossPlan
            ? await confirmProtectiveStopLoss(
              stopLossResult,
              stopLossPlan.triggerPrice,
              stopLossPlan.limitPrice,
            )
            : { success: true, protected: false, skipped: true };

          if (slVerification.executedImmediately) {
            stopLossOrderId = slVerification.orderId;
            premiumStopLoss = stopLossPlan.triggerPrice;
            premiumStopLossCandle = stopLossPlan.candle;

            createTrade({
              signal,
              tradeMode: activeTradeMode,
              entryOrderId: entryConfirmation.orderId,
              securityId: contract.SEM_SMST_SECURITY_ID,
              quantity,
              optionSymbol: contract.SEM_CUSTOM_SYMBOL,
              stopLossOrderId,
              premiumStopLoss,
              premiumStopLossCandle,
              premiumSlInterval: stopLossPlan?.interval || effectiveInterval,
              entryPremiumReference: actualEntryFillPrice,
              riskPoints: actualRiskPoints,
              riskSource: "ACTUAL_FILL",
            });
            recordSuccessfulEntry(activeTradeMode);
            markTradeStopLossHit(stopLossOrderId);
            clearOpenPosition();
            logger.warn(
              `LONG_ENTRY premium SL executed immediately: ${stopLossOrderId}`,
            );
            sendTelegram(
              `⚠️ LONG_ENTRY stopped immediately\n\nActual Fill : ${actualEntryFillPrice}\nPremium SL : ${stopLossPlan.triggerPrice}\nSL Order ID : ${stopLossOrderId}`,
            );
            return res.status(200).send("LONG_ENTRY stopped immediately\n");
          }

          if (!slVerification.success) {
            if (slVerification.orderId) {
              await cancelOrder(slVerification.orderId);
            }

            const executedStopLoss =
              await getExecutedStopLossAfterCancel(slVerification.orderId);

            if (executedStopLoss) {
              stopLossOrderId = executedStopLoss.orderId;
              premiumStopLoss = stopLossPlan.triggerPrice;
              premiumStopLossCandle = stopLossPlan.candle;

              createTrade({
                signal,
                tradeMode: activeTradeMode,
                entryOrderId: entryConfirmation.orderId,
                securityId: contract.SEM_SMST_SECURITY_ID,
                quantity,
                optionSymbol: contract.SEM_CUSTOM_SYMBOL,
                stopLossOrderId,
                premiumStopLoss,
                premiumStopLossCandle,
                premiumSlInterval: stopLossPlan?.interval || effectiveInterval,
                entryPremiumReference: actualEntryFillPrice,
                riskPoints: actualRiskPoints,
                riskSource: "ACTUAL_FILL",
              });
              recordSuccessfulEntry(activeTradeMode);
              markTradeStopLossHit(stopLossOrderId);
              clearOpenPosition();
              logger.warn(
                `LONG_ENTRY premium SL traded during verification: ${stopLossOrderId}`,
              );
              return res.status(200).send("LONG_ENTRY stopped immediately\n");
            }

            const safetyResult = await handleUnsafeFilledEntry({
              signal,
              activeTradeMode,
              contract,
              quantity,
              entryOrderId: entryConfirmation.orderId,
              entryFillPrice: actualEntryFillPrice,
              riskPlan,
              sizing,
              reason: `Protective SL verification failed: ${slVerification.error}`,
            });

            sendTelegram(
              safetyResult.exited
                ? `⚠️ LONG_ENTRY exited because SL protection failed\n\nReason: ${slVerification.error}`
                : `🚨 LONG_ENTRY is OPEN and UNPROTECTED\n\nSL verification: ${slVerification.error}\nSafety exit: ${safetyResult.exitConfirmation.error}`,
            );

            return res
              .status(200)
              .send(
                safetyResult.exited
                  ? "LONG_ENTRY exited after SL verification failure\n"
                  : "LONG_ENTRY unprotected; safety exit failed\n",
              );
          }

          stopLossOrderId = slVerification.protected
            ? slVerification.orderId
            : null;
          premiumStopLoss = stopLossPlan ? stopLossPlan.triggerPrice : null;
          premiumStopLossCandle = stopLossPlan ? stopLossPlan.candle : null;

          createTrade({
            signal,
            tradeMode: activeTradeMode,
            entryOrderId: getOrderId(orderResult),
            securityId: contract.SEM_SMST_SECURITY_ID,
            quantity,
            optionSymbol: contract.SEM_CUSTOM_SYMBOL,
            stopLossOrderId,
            premiumStopLoss,
            premiumStopLossCandle,
            premiumSlInterval: stopLossPlan?.interval || effectiveInterval,
            entryPremiumReference: actualEntryFillPrice,
            riskPoints: stopLossPlan ? actualRiskPoints : sizing.riskPoints,
            riskSource: stopLossPlan ? "ACTUAL_FILL" : riskPlan.source,
          });

          // Persist the position so a restarted server can still exit it.
          savePosition({
            currentPosition,
            tradeMode: currentPositionMode,
            securityId: contract.SEM_SMST_SECURITY_ID,
            quantity,
            optionSymbol: contract.SEM_CUSTOM_SYMBOL,
            stopLossOrderId,
            premiumStopLoss,
            premiumStopLossCandle,
            entryPremiumReference: actualEntryFillPrice,
            riskPoints: stopLossPlan ? actualRiskPoints : sizing.riskPoints,
            riskSource: stopLossPlan ? "ACTUAL_FILL" : riskPlan.source,
          });

          const tradeLimitStatus = recordSuccessfulEntry(activeTradeMode);

          await sendTelegram(
            `${emoji} ${getTradeModeLabel(config, "TRADE")}

Signal : LONG_ENTRY

Position : LONG

Underlying : ${symbol}

Spot Price : ${price}

Selected :
${contract.SEM_CUSTOM_SYMBOL}

Security ID :
${contract.SEM_SMST_SECURITY_ID}

Lot Size : ${sizing.lotSize}
Lots : ${sizing.finalLots}
Quantity : ${quantity}
Risk Amount : ${sizing.riskAmount}
Loss Per Lot : ${sizing.lossPerLot}
Risk Source : ${riskPlan.source}
Entry Premium Reference : ${riskPlan.entryPremium || "-"}
Risk Points : ${sizing.riskPoints}

Premium SL : ${premiumStopLoss || "-"}
SL Order ID : ${stopLossOrderId || "-"}

Trades Today : ${tradeLimitStatus.entryCount}

${getOrderPlacementNote(config)}`,
          );

          break;
        } catch (err) {
          logger.error("LONG_ENTRY FAILED", err);
          return res.status(500).send("LONG_ENTRY failed");
        }
      }
      //  =============================== SHORT ENTRY ===============================
      case "SHORT_ENTRY": {
        // Ignore duplicate short-side entries while already short.
        if (
          currentPosition === "SHORT" &&
          currentPositionBelongsToMode(activeTradeMode)
        ) {
          logger.warn("Duplicate SHORT_ENTRY ignored");

          await sendTelegram(
            `⚠️ Duplicate SHORT ignored

Already in SHORT position.

Symbol : ${symbol}
Price : ${price}

No order placed.`,
          );

          return res.status(200).send("Duplicate ignored");
        }
        try {
          // Avoid opening a second position before the first one is closed.
          if (currentPosition !== null) {
            await sendTelegram(
              `⚠️ SHORT_ENTRY ignored

Current Position : ${currentPosition}
Position Mode    : ${normalizeTradeMode(currentPositionMode)}
Signal Mode      : ${activeTradeMode}`,
            );

            return res.status(200).send("Position already open");
          }

          const option = getOptionDetails(signal, price);

          // SHORT_ENTRY maps to a PE contract in optionSelector.
          const contract = getNiftyOption(option.strike, option.optionType);

          if (!contract) {
            logger.error("No matching option contract found");

            await sendTelegram(
              `❌ Contract Not Found

Signal : ${signal}
Symbol : ${symbol}
Price  : ${price}

No matching NIFTY option contract found.

No order placed.`,
            );

            return res.status(200).send("Contract not found");
          }

          logger.info(
            `Selected Contract: ${contract.SEM_CUSTOM_SYMBOL} securityId=${contract.SEM_SMST_SECURITY_ID} expiry=${contract.SEM_EXPIRY_DATE}`,
          );

          const stopLossPlan = await getPremiumStopLossPlan(
            contract,
            config,
            time,
            alertInterval,
          );

          if (stopLossPlan && !stopLossPlan.success) {
            return rejectPremiumStopLossFailure(
              res,
              signal,
              symbol,
              price,
              stopLossPlan,
            );
          }

          const riskPlan = await getEntryRiskPlan(
            contract,
            config,
            stopLossPlan,
          );

          if (!riskPlan.success) {
            return rejectPremiumStopLossFailure(
              res,
              signal,
              symbol,
              price,
              riskPlan,
            );
          }

          const minimumPremiumSlPoints =
            getMinimumPremiumSlPoints(config);

          if (
            stopLossPlan &&
            riskPlan.riskPoints < minimumPremiumSlPoints
          ) {
            return rejectPremiumStopLossFailure(
              res,
              signal,
              symbol,
              price,
              {
                error:
                  `Premium SL distance ${riskPlan.riskPoints} is below minimum ` +
                  `${minimumPremiumSlPoints}`,
                entryPremium: riskPlan.entryPremium,
                stopLossPremium: riskPlan.stopLossPremium,
              },
            );
          }

          const sizing = getEntrySizing(
            signal,
            config,
            riskPlan.riskPoints,
          );

          logger.info(
            `Entry sizing: source=${riskPlan.source} premium=${riskPlan.entryPremium ?? "n/a"} premiumSL=${riskPlan.stopLossPremium ?? "n/a"} candleLow=${stopLossPlan?.candle?.low ?? "n/a"} candleHigh=${stopLossPlan?.candle?.high ?? "n/a"} candleRange=${stopLossPlan?.candleRange ?? "n/a"} halfCandle=${stopLossPlan?.hugeCandleAdjusted ?? false} hugeThreshold=${stopLossPlan?.hugeCandleThreshold ?? "n/a"} riskPoints=${sizing.riskPoints} riskAmount=${sizing.riskAmount} lossPerLot=${sizing.lossPerLot} baseLots=${sizing.lots} lots=${sizing.finalLots} quantity=${sizing.quantity}`,
          );

          if (!sizing.quantity || sizing.quantity <= 0) {
            return rejectInvalidEntrySize(res, signal, symbol, price, sizing);
          }

          quantity = sizing.quantity;

          // Cache contract details in memory so the matching exit can sell them.
          securityId = contract.SEM_SMST_SECURITY_ID;
          optionSymbol = contract.SEM_CUSTOM_SYMBOL;

          console.log(contract);

          logger.info(`Selected Option: ${option.strike} ${option.optionType}`);

          console.log("ORDER QUANTITY");
          console.log(quantity);

          const orderResult = await placeMarketBuyOrder(contract, quantity);

          console.log(orderResult);

          // Only mark position open after Dhan/paper order reports success.
          if (!orderResult.success) {
            await sendTelegram(
              `❌ SHORT_ENTRY failed

Symbol : ${symbol}
Price  : ${price}

Reason:
${JSON.stringify(orderResult.error, null, 2)}

Position NOT changed.`,
            );

            return res.status(200).send("SHORT_ENTRY failed\n");
          }

          const entryConfirmation =
            await confirmEntryOrderExecution(orderResult);

          if (!entryConfirmation.success) {
            logger.error(
              `SHORT_ENTRY broker order not filled: ${entryConfirmation.error}`,
            );
            sendTelegram(
              `❌ SHORT_ENTRY rejected by Dhan

Symbol : ${symbol}
Price  : ${price}
Order ID : ${entryConfirmation.orderId || "-"}
Status : ${entryConfirmation.status || "UNKNOWN"}

Reason:
${entryConfirmation.error}

Position NOT changed.`,
            );

            return res.status(200).send("SHORT_ENTRY broker order not filled\n");
          }

          const actualEntryFillPrice = getExecutedPrice(
            entryConfirmation,
            riskPlan.entryPremium,
          );
          const actualRiskPoints = Number(
            (
              actualEntryFillPrice -
              Number(stopLossPlan?.triggerPrice || 0)
            ).toFixed(2),
          );

          logger.info(
            `SHORT_ENTRY actual fill: premium=${actualEntryFillPrice} premiumSL=${stopLossPlan?.triggerPrice ?? "n/a"} riskPoints=${actualRiskPoints}`,
          );

          if (
            stopLossPlan &&
            actualRiskPoints < minimumPremiumSlPoints
          ) {
            const safetyResult = await handleUnsafeFilledEntry({
              signal,
              activeTradeMode,
              contract,
              quantity,
              entryOrderId: entryConfirmation.orderId,
              entryFillPrice: actualEntryFillPrice,
              riskPlan,
              sizing,
              reason:
                `Actual fill-to-SL distance ${actualRiskPoints} is below minimum ` +
                `${minimumPremiumSlPoints}`,
            });

            sendTelegram(
              safetyResult.exited
                ? `⚠️ SHORT_ENTRY immediately exited for safety\n\nActual Fill : ${actualEntryFillPrice}\nPremium SL : ${stopLossPlan.triggerPrice}\nDistance : ${actualRiskPoints}\nMinimum : ${minimumPremiumSlPoints}`
                : `🚨 SHORT_ENTRY is OPEN and UNPROTECTED\n\nSafety exit failed: ${safetyResult.exitConfirmation.error}`,
            );

            return res
              .status(200)
              .send(
                safetyResult.exited
                  ? "SHORT_ENTRY safety exited\n"
                  : "SHORT_ENTRY safety exit failed\n",
              );
          }

          currentPosition = "SHORT";
          currentPositionMode = activeTradeMode;

          logger.info("Position changed to SHORT");

          const stopLossResult = await placeProtectiveStopLoss(
            contract,
            quantity,
            stopLossPlan,
          );

          const slVerification = stopLossPlan
            ? await confirmProtectiveStopLoss(
              stopLossResult,
              stopLossPlan.triggerPrice,
              stopLossPlan.limitPrice,
            )
            : { success: true, protected: false, skipped: true };

          if (slVerification.executedImmediately) {
            stopLossOrderId = slVerification.orderId;
            premiumStopLoss = stopLossPlan.triggerPrice;
            premiumStopLossCandle = stopLossPlan.candle;

            createTrade({
              signal,
              tradeMode: activeTradeMode,
              entryOrderId: entryConfirmation.orderId,
              securityId: contract.SEM_SMST_SECURITY_ID,
              quantity,
              optionSymbol: contract.SEM_CUSTOM_SYMBOL,
              stopLossOrderId,
              premiumStopLoss,
              premiumStopLossCandle,
              premiumSlInterval: stopLossPlan?.interval || effectiveInterval,
              entryPremiumReference: actualEntryFillPrice,
              riskPoints: actualRiskPoints,
              riskSource: "ACTUAL_FILL",
            });
            recordSuccessfulEntry(activeTradeMode);
            markTradeStopLossHit(stopLossOrderId);
            clearOpenPosition();
            logger.warn(
              `SHORT_ENTRY premium SL executed immediately: ${stopLossOrderId}`,
            );
            sendTelegram(
              `⚠️ SHORT_ENTRY stopped immediately\n\nActual Fill : ${actualEntryFillPrice}\nPremium SL : ${stopLossPlan.triggerPrice}\nSL Order ID : ${stopLossOrderId}`,
            );
            return res.status(200).send("SHORT_ENTRY stopped immediately\n");
          }

          if (!slVerification.success) {
            if (slVerification.orderId) {
              await cancelOrder(slVerification.orderId);
            }

            const executedStopLoss =
              await getExecutedStopLossAfterCancel(slVerification.orderId);

            if (executedStopLoss) {
              stopLossOrderId = executedStopLoss.orderId;
              premiumStopLoss = stopLossPlan.triggerPrice;
              premiumStopLossCandle = stopLossPlan.candle;

              createTrade({
                signal,
                tradeMode: activeTradeMode,
                entryOrderId: entryConfirmation.orderId,
                securityId: contract.SEM_SMST_SECURITY_ID,
                quantity,
                optionSymbol: contract.SEM_CUSTOM_SYMBOL,
                stopLossOrderId,
                premiumStopLoss,
                premiumStopLossCandle,
                premiumSlInterval: stopLossPlan?.interval || effectiveInterval,
                entryPremiumReference: actualEntryFillPrice,
                riskPoints: actualRiskPoints,
                riskSource: "ACTUAL_FILL",
              });
              recordSuccessfulEntry(activeTradeMode);
              markTradeStopLossHit(stopLossOrderId);
              clearOpenPosition();
              logger.warn(
                `SHORT_ENTRY premium SL traded during verification: ${stopLossOrderId}`,
              );
              return res.status(200).send("SHORT_ENTRY stopped immediately\n");
            }

            const safetyResult = await handleUnsafeFilledEntry({
              signal,
              activeTradeMode,
              contract,
              quantity,
              entryOrderId: entryConfirmation.orderId,
              entryFillPrice: actualEntryFillPrice,
              riskPlan,
              sizing,
              reason: `Protective SL verification failed: ${slVerification.error}`,
            });

            sendTelegram(
              safetyResult.exited
                ? `⚠️ SHORT_ENTRY exited because SL protection failed\n\nReason: ${slVerification.error}`
                : `🚨 SHORT_ENTRY is OPEN and UNPROTECTED\n\nSL verification: ${slVerification.error}\nSafety exit: ${safetyResult.exitConfirmation.error}`,
            );

            return res
              .status(200)
              .send(
                safetyResult.exited
                  ? "SHORT_ENTRY exited after SL verification failure\n"
                  : "SHORT_ENTRY unprotected; safety exit failed\n",
              );
          }

          stopLossOrderId = slVerification.protected
            ? slVerification.orderId
            : null;
          premiumStopLoss = stopLossPlan ? stopLossPlan.triggerPrice : null;
          premiumStopLossCandle = stopLossPlan ? stopLossPlan.candle : null;

          createTrade({
            signal,
            tradeMode: activeTradeMode,
            entryOrderId: getOrderId(orderResult),
            securityId: contract.SEM_SMST_SECURITY_ID,
            quantity,
            optionSymbol: contract.SEM_CUSTOM_SYMBOL,
            stopLossOrderId,
            premiumStopLoss,
            premiumStopLossCandle,
            premiumSlInterval: stopLossPlan?.interval || effectiveInterval,
            entryPremiumReference: actualEntryFillPrice,
            riskPoints: stopLossPlan ? actualRiskPoints : sizing.riskPoints,
            riskSource: stopLossPlan ? "ACTUAL_FILL" : riskPlan.source,
          });

          // Persist the position so a restarted server can still exit it.
          savePosition({
            currentPosition,
            tradeMode: currentPositionMode,
            securityId: contract.SEM_SMST_SECURITY_ID,
            quantity,
            optionSymbol: contract.SEM_CUSTOM_SYMBOL,
            stopLossOrderId,
            premiumStopLoss,
            premiumStopLossCandle,
            entryPremiumReference: actualEntryFillPrice,
            riskPoints: stopLossPlan ? actualRiskPoints : sizing.riskPoints,
            riskSource: stopLossPlan ? "ACTUAL_FILL" : riskPlan.source,
          });

          const tradeLimitStatus = recordSuccessfulEntry(activeTradeMode);

          await sendTelegram(
            `${emoji} ${getTradeModeLabel(config, "TRADE")}

Signal : SHORT_ENTRY

Position : SHORT

Underlying : ${symbol}

Spot Price : ${price}

Selected :
${contract.SEM_CUSTOM_SYMBOL}

Security ID :
${contract.SEM_SMST_SECURITY_ID}

Lot Size : ${sizing.lotSize}
Lots : ${sizing.finalLots}
Quantity : ${quantity}
Risk Amount : ${sizing.riskAmount}
Loss Per Lot : ${sizing.lossPerLot}
Risk Source : ${riskPlan.source}
Entry Premium Reference : ${riskPlan.entryPremium || "-"}
Risk Points : ${sizing.riskPoints}

Premium SL : ${premiumStopLoss || "-"}
SL Order ID : ${stopLossOrderId || "-"}

Trades Today : ${tradeLimitStatus.entryCount}

${getOrderPlacementNote(config)}`,
          );

          break;
        } catch (err) {
          logger.error("SHORT_ENTRY FAILED", err);
          return res.status(500).send("SHORT_ENTRY failed");
        }
      }
      //  =============================== LONG EXIT ===============================
      case "LONG_EXIT": {
        // Exit signals are ignored unless the matching position is open.
        if (
          currentPosition !== "LONG" ||
          !currentPositionBelongsToMode(activeTradeMode)
        ) {
          logger.warn("LONG_EXIT ignored because no LONG position is open");
          return res.status(200).send("No LONG position");
        }

        console.log("EXIT SECURITY ID =", securityId);
        console.log("EXIT QUANTITY =", quantity);

        const exitSecurityId = securityId;
        const exitQuantity = quantity;
        const exitOptionSymbol = optionSymbol;

        if (shouldIgnoreTradingViewExit(config) && !manualSignal) {
          return ignoreTradingViewExit(
            res,
            signal,
            symbol,
            price,
            exitOptionSymbol,
          );
        }

        if (manualSignal && stopLossOrderId) {
          logger.info(
            `Manual LONG_EXIT overriding premium stop-loss order ${stopLossOrderId}`,
          );
        }

        const cancelStopLossResult =
          await cancelProtectiveStopLossForTradingViewExit(
            signal,
            exitOptionSymbol,
          );

        if (!cancelStopLossResult.success) {
          return res.status(200).send("Stop loss cancel failed\n");
        }

        // Attempt the broker/paper SELL before changing local position state.
        const exitResult = await placeMarketSellOrder(
          exitSecurityId,
          exitQuantity,
        );
        console.log(exitResult);

        // If Dhan rejects the exit, keep the bot position open for retry/manual action.
        if (!exitResult.success) {
          await sendTelegram(
            `❌ LONG_EXIT failed

Contract :
${exitOptionSymbol}

Security ID :
${exitSecurityId}

Qty :
${exitQuantity}

Reason:
${JSON.stringify(exitResult.error, null, 2)}

Position still marked OPEN.`,
          );

          return res.status(200).send("LONG_EXIT failed\n");
        }

        markLatestOpenTradeExited({
          signal,
          exitOrderId: getOrderId(exitResult),
          tradeMode: activeTradeMode,
        });
        clearOpenPosition();
        logger.info(`Position closed: ${exitOptionSymbol}`);

        await sendTelegram(
          `${emoji} ${getTradeModeLabel(config, "EXIT")}

Signal : LONG_EXIT

Contract :
${exitOptionSymbol}

Security ID :
${exitSecurityId}

Qty :
${exitQuantity}

Position Closed`,
        );

        break;
      }
      //  =============================== SHORT EXIT ===============================
      case "SHORT_EXIT": {
        // Exit signals are ignored unless the matching position is open.
        if (
          currentPosition !== "SHORT" ||
          !currentPositionBelongsToMode(activeTradeMode)
        ) {
          logger.warn("SHORT_EXIT ignored because no SHORT position is open");
          return res.status(200).send("No SHORT position");
        }

        console.log("EXIT SECURITY ID =", securityId);
        console.log("EXIT QUANTITY =", quantity);

        const exitSecurityId = securityId;
        const exitQuantity = quantity;
        const exitOptionSymbol = optionSymbol;

        if (shouldIgnoreTradingViewExit(config) && !manualSignal) {
          return ignoreTradingViewExit(
            res,
            signal,
            symbol,
            price,
            exitOptionSymbol,
          );
        }

        if (manualSignal && stopLossOrderId) {
          logger.info(
            `Manual SHORT_EXIT overriding premium stop-loss order ${stopLossOrderId}`,
          );
        }

        const cancelStopLossResult =
          await cancelProtectiveStopLossForTradingViewExit(
            signal,
            exitOptionSymbol,
          );

        if (!cancelStopLossResult.success) {
          return res.status(200).send("Stop loss cancel failed\n");
        }

        // Attempt the broker/paper SELL before changing local position state.
        const exitResult = await placeMarketSellOrder(
          exitSecurityId,
          exitQuantity,
        );

        console.log(exitResult);

        // If Dhan rejects the exit, keep the bot position open for retry/manual action.
        if (!exitResult.success) {
          await sendTelegram(
            `❌ SHORT_EXIT failed

Contract :
${exitOptionSymbol}

Security ID :
${exitSecurityId}

Qty :
${exitQuantity}

Reason:
${JSON.stringify(exitResult.error, null, 2)}

Position still marked OPEN.`,
          );

          return res.status(200).send("SHORT_EXIT failed\n");
        }

        markLatestOpenTradeExited({
          signal,
          exitOrderId: getOrderId(exitResult),
          tradeMode: activeTradeMode,
        });
        clearOpenPosition();
        logger.info(`Position closed: ${exitOptionSymbol}`);

        await sendTelegram(
          `${emoji} ${getTradeModeLabel(config, "EXIT")}

Signal : SHORT_EXIT

Contract :
${exitOptionSymbol}

Security ID :
${exitSecurityId}

Qty :
${exitQuantity}

Position Closed`,
        );

        break;
      }
      default:
        // Unknown signals are reported but never traded.
        logger.warn(`Unknown signal received: ${signal}`);

        await sendTelegram(
          `⚠️ Unknown Signal Received

Signal : ${signal}
Symbol : ${symbol}
Price  : ${price}

No order placed.`,
        );

        return res.status(200).send("Unknown signal ignored");
    }

    console.log(`Current Position = ${currentPosition}`);

    res.status(200).send("Webhook processed\n");
  } catch (error) {
    logger.error(error.message);

    res.status(500).send("Webhook failed");
  }
});

// Broker health endpoint consumed by the control dashboard.
app.get("/dhan-health", async (req, res) => {
  const health = await checkDhanHealth();

  res.json({
    ...health,
    checkedAt: new Date().toISOString(),
  });
});

// NIFTY spot LTP endpoint used by the manual signal panel.
app.get("/nifty-spot", async (req, res) => {
  try {
    const spot = await getNiftySpotLtp();
    res.json({
      success: true,
      ...spot,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.response?.data?.errorMessage || error.message,
      error: error.response?.data || error.message,
    });
  }
});

// Start the algo webhook server.
server = app.listen(PORT, () => {
  logger.info(`LIFECYCLE Algo server listening on port ${PORT}`);
  console.log(`Server running on port ${PORT}`);
});

function shutdown(signal) {
  logger.info(`LIFECYCLE Algo server received ${signal}, shutting down`);

  if (!server) {
    process.exit(0);
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
