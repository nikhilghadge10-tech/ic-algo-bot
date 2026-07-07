/*
 * Main algo webhook server.
 * Receives TradingView-style signals, selects the configured index option contract,
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
  getPositions,
  modifyStopLossLimitSellOrder,
  placeMarketBuyOrder,
  placeMarketSellOrder,
  placeStopLossLimitSellOrder,
} = require("./services/dhanOrderService");

const { placeOrder, checkDhanHealth } = require("./services/dhanService");

const {
  loadInstruments,
  getIndexOption,
} = require("./services/instrumentService");
const {
  getDailyTradeLimitStatus,
  normalizeTradeMode,
  recordSuccessfulEntry,
} = require("./services/tradeLimitService");
const {
  getUnderlyingSpotLtp,
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
  updateLatestOpenTradeMarket,
  updateLatestOpenTradeStopLoss,
} = require("./services/tradeHistoryService");
const {
  getUnderlyingProfile,
  getUnderlyingProfileForSymbol,
  isAllowedUnderlyingSymbol: isConfiguredUnderlyingSymbol,
} = require("./services/underlyingService");
const {
  applyDailyControlReset,
} = require("./services/dailyControlResetService");

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
const BROKER_POSITION_SYNC_INTERVAL_MS =
  Number(process.env.BROKER_POSITION_SYNC_INTERVAL_MS || 15000) || 15000;
const AUTO_TRAIL_INTERVAL_MS =
  Number(process.env.AUTO_TRAIL_INTERVAL_MS || 15000) || 15000;
const AUTO_TRAIL_MARKET_METRICS_FRESH_MS =
  Number(process.env.AUTO_TRAIL_MARKET_METRICS_FRESH_MS || 10000) || 10000;
let brokerPositionSyncInFlight = false;
let autoTrailInFlight = false;
let lastAutoTrailLogKey = "";
let lastAutoTrailLogAt = 0;
let lastMarketMetricsWarningAt = 0;

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
  await syncActiveBrokerPosition("STATUS");

  const activeTradeMode = getTradeMode(statusConfig);
  const underlyingProfile = getActiveUnderlyingProfile(statusConfig);
  statusConfig.LOT_SIZE = statusConfig.LOT_SIZE || String(underlyingProfile.lotSize);
  statusConfig.STRIKE_STEP =
    statusConfig.STRIKE_STEP || String(underlyingProfile.strikeStep);
  statusConfig.PLANNING_SL_POINTS =
    statusConfig.PLANNING_SL_POINTS || String(underlyingProfile.planningSlPoints);
  const positionBelongsToActiveMode =
    currentPosition && normalizeTradeMode(currentPositionMode) === activeTradeMode;
  const savedPosition = loadPosition();

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
    underlyingSymbol: underlyingProfile.symbol,
    underlyingDisplayName: underlyingProfile.displayName,
    underlyingSpotSegment: underlyingProfile.spotSegment,
    underlyingSpotSecurityId: underlyingProfile.spotSecurityId,
    strikeStep: statusConfig.STRIKE_STEP,
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
    autoTrailSl: statusConfig.AUTO_TRAIL_SL,
    autoTrailIntervalMs: AUTO_TRAIL_INTERVAL_MS,
    premiumSlInterval: statusConfig.PREMIUM_SL_INTERVAL,
    premiumSlLimitBand: statusConfig.PREMIUM_SL_LIMIT_BAND,
    brokerPositionSyncIntervalMs: BROKER_POSITION_SYNC_INTERVAL_MS,
    activePosition: positionBelongsToActiveMode
      ? {
          currentPosition,
          tradeMode: currentPositionMode,
          securityId,
          quantity,
          optionSymbol,
          stopLossOrderId,
          premiumStopLoss,
          capitalDeployed: savedPosition.capitalDeployed || null,
          stopLossMoney: savedPosition.stopLossMoney || null,
          currentPremium: savedPosition.currentPremium || null,
          currentPremiumCheckedAt: savedPosition.currentPremiumCheckedAt || null,
          runningProfitAmount: savedPosition.runningProfitAmount ?? null,
          runningProfitPercent: savedPosition.runningProfitPercent ?? null,
          riskRewardRatio: savedPosition.riskRewardRatio ?? null,
          riskReward: savedPosition.riskReward || null,
        }
      : null,
  });
});

app.post("/trail-stop-loss", async (req, res) => {
  const triggerPrice = Number(req.body?.triggerPrice);
  const limitPrice = Number(req.body?.limitPrice);

  const result = await trailStopLossOrder({
    triggerPrice,
    limitPrice,
    source: "MANUAL",
  });

  return res.status(result.statusCode).json(result.body);
});

async function trailStopLossOrder({ triggerPrice, limitPrice, source = "MANUAL" }) {
  const sourceLabel = source === "AUTO" ? "Automatic" : "Manual";

  await syncActiveStopLossStatus();

  if (!currentPosition || !stopLossOrderId) {
    return {
      statusCode: 400,
      body: {
        success: false,
        message: "No active protective stop-loss order to trail",
      },
    };
  }

  if (
    !Number.isFinite(triggerPrice) ||
    triggerPrice <= 0 ||
    !Number.isFinite(limitPrice) ||
    limitPrice <= 0
  ) {
    return {
      statusCode: 400,
      body: {
        success: false,
        message: "Enter valid trigger and limit prices",
      },
    };
  }

  if (limitPrice >= triggerPrice) {
    return {
      statusCode: 400,
      body: {
        success: false,
        message: "For SELL SL-Limit, limit price must be below trigger price",
      },
    };
  }

  if (
    source !== "MANUAL" &&
    premiumStopLoss &&
    triggerPrice <= Number(premiumStopLoss)
  ) {
    return {
      statusCode: 400,
      body: {
        success: false,
        message: `New trigger must be above current tracked SL ${premiumStopLoss}`,
      },
    };
  }

  const trackedStopLossOrderId = stopLossOrderId;
  const statusResult = await getOrderStatus(trackedStopLossOrderId);

  if (!statusResult.success) {
    return {
      statusCode: 502,
      body: {
        success: false,
        message: "Unable to verify current stop-loss order status",
        error: statusResult.error,
      },
    };
  }

  const orderStatus = getBrokerOrderStatus(statusResult);

  if (["TRADED", "EXECUTED", "FILLED", "COMPLETE", "COMPLETED"].includes(orderStatus)) {
    markTradeStopLossHit({
      orderId: trackedStopLossOrderId,
      exitPrice: getExecutedPrice(statusResult, premiumStopLoss),
    });
    clearOpenPosition();
    return {
      statusCode: 409,
      body: {
        success: false,
        message: "Stop-loss order is already executed; position was synced flat",
        status: orderStatus,
      },
    };
  }

  if (["CANCELLED", "REJECTED", "EXPIRED"].includes(orderStatus)) {
    return {
      statusCode: 409,
      body: {
        success: false,
        message: `Stop-loss order cannot be modified because it is ${orderStatus}`,
        status: orderStatus,
      },
    };
  }

  const activeTradeMode = getTradeMode(getRuntimeConfig());

  if (activeTradeMode !== "PAPER") {
    const brokerPosition = await getBrokerOpenQuantityForSecurity(securityId);

    if (!brokerPosition.success) {
      return {
        statusCode: 502,
        body: {
          success: false,
          message: "Unable to verify broker position before trailing SL",
          error: brokerPosition.error,
        },
      };
    }

    if (brokerPosition.quantity <= 0) {
      return {
        statusCode: 409,
        body: {
          success: false,
          message:
            "Dhan positions show no open quantity for this security. Do not trail this SL.",
        },
      };
    }
  }

  const modifyResult = await modifyStopLossLimitSellOrder({
    orderId: trackedStopLossOrderId,
    quantity,
    triggerPrice,
    limitPrice,
  });

  if (!modifyResult.success) {
    return {
      statusCode: 502,
      body: {
        success: false,
        message: "Dhan rejected stop-loss trail request",
        error: modifyResult.error,
      },
    };
  }

  const trailVerification = await confirmStopLossTrailUpdate(
    trackedStopLossOrderId,
    triggerPrice,
    limitPrice,
  );

  if (!trailVerification.success) {
    if (trailVerification.executed) {
      markTradeStopLossHit({
        orderId: trackedStopLossOrderId,
        exitPrice: getExecutedPrice(trailVerification, premiumStopLoss),
      });
      clearOpenPosition();
    }

    await sendTelegram(
      `⚠️ ${sourceLabel} Stop Loss Trail Not Confirmed

Contract :
${optionSymbol}

SL Order ID :
${trackedStopLossOrderId}

Requested Trigger :
${triggerPrice}

Requested Limit :
${limitPrice}

Reason:
${trailVerification.error || "Broker did not confirm the updated SL order"}

Please check Dhan orders manually.`,
    );

    return {
      statusCode: 409,
      body: {
        success: false,
        message: "Dhan accepted the trail request, but the updated SL was not confirmed",
        error: trailVerification.error,
        status: trailVerification.status,
        order: trailVerification.order,
      },
    };
  }

  saveOpenPositionTrailUpdate({ triggerPrice });

  logger.info(
    `${sourceLabel} SL trail confirmed: orderId=${trackedStopLossOrderId} trigger=${triggerPrice} limit=${limitPrice} status=${trailVerification.status}`,
  );

  await sendTelegram(
    `✅ ${sourceLabel} Stop Loss Trailed

Contract :
${optionSymbol}

SL Order ID :
${trackedStopLossOrderId}

Trigger :
${triggerPrice}

Limit :
${limitPrice}`,
  );

  return {
    statusCode: 200,
    body: {
      success: true,
      message: `Stop-loss trailed to ${triggerPrice}`,
      orderId: trackedStopLossOrderId,
      triggerPrice: trailVerification.triggerPrice,
      limitPrice: trailVerification.limitPrice,
      status: trailVerification.status,
      result: modifyResult.data,
    },
  };
}

function getAutoTrailContext(config, updatedTrade) {
  const savedPosition = loadPosition();

  return {
    savedPosition,
    entryPremium: Number(
      savedPosition.entryPremiumReference ||
        savedPosition.entryPrice ||
        updatedTrade?.entryPrice,
    ),
    currentOptionPremium: Number(
      updatedTrade?.currentPremium || savedPosition.currentPremium,
    ),
    currentStopLoss: Number(premiumStopLoss || savedPosition.premiumStopLoss),
    riskPoints: Number(updatedTrade?.riskPoints || savedPosition.riskPoints),
    limitBand: Number(config.PREMIUM_SL_LIMIT_BAND || 1) || 1,
  };
}

function hasAutoTrailBaseMetrics(context) {
  return (
    currentPosition &&
    stopLossOrderId &&
    Number.isFinite(context.entryPremium) &&
    context.entryPremium > 0 &&
    Number.isFinite(context.currentOptionPremium) &&
    context.currentOptionPremium > 0 &&
    Number.isFinite(context.currentStopLoss) &&
    context.currentStopLoss > 0
  );
}

function buildAutoCostToCostTrailPlan(config, context) {
  const thresholdPercent = Number(config.TRAIL_COST_TO_COST_PERCENT || 7);

  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0) {
    return {
      eligible: false,
      logKey: `invalid-threshold:${config.TRAIL_COST_TO_COST_PERCENT}`,
      message: "AUTO_TRAIL skipped: cost-to-cost threshold is invalid",
    };
  }

  const targetPremium = roundToTick(
    context.entryPremium * (1 + thresholdPercent / 100),
    0.05,
  );
  const triggerPrice = roundToTick(context.entryPremium, 0.05);
  const limitPrice = roundToTick(triggerPrice - context.limitBand, 0.05);

  if (context.currentOptionPremium < targetPremium) {
    return {
      eligible: false,
      logKey: `below:${context.currentOptionPremium}:${targetPremium}`,
      message:
        `AUTO_TRAIL waiting: premium=${context.currentOptionPremium} ` +
        `target=${targetPremium} threshold=${thresholdPercent}%`,
    };
  }

  if (triggerPrice <= context.currentStopLoss) {
    return {
      eligible: false,
      logKey: `already-protected:${triggerPrice}:${context.currentStopLoss}`,
      message:
        `AUTO_TRAIL skipped: cost SL=${triggerPrice} is not above ` +
        `current SL=${context.currentStopLoss}`,
    };
  }

  if (!limitPrice || limitPrice <= 0 || limitPrice >= triggerPrice) {
    return {
      eligible: false,
      logKey: `invalid-prices:${triggerPrice}:${limitPrice}`,
      message:
        `AUTO_TRAIL skipped: invalid SL-Limit prices ` +
        `trigger=${triggerPrice} limit=${limitPrice}`,
    };
  }

  return {
    eligible: true,
    triggerPrice,
    limitPrice,
    targetPremium,
    currentOptionPremium: context.currentOptionPremium,
    thresholdPercent,
    logKey: `trail:${triggerPrice}:${limitPrice}:${context.currentOptionPremium}`,
    message:
      `AUTO_TRAIL eligible: premium=${context.currentOptionPremium} ` +
      `target=${targetPremium} trigger=${triggerPrice} limit=${limitPrice}`,
  };
}

function getClassicAutoTrailSteps(config) {
  return [
    ["TRAIL_CLASSIC_TRIGGER_RR_1", "TRAIL_CLASSIC_LOCK_RR_1", 3, 1],
    ["TRAIL_CLASSIC_TRIGGER_RR_2", "TRAIL_CLASSIC_LOCK_RR_2", 5, 3],
    ["TRAIL_CLASSIC_TRIGGER_RR_3", "TRAIL_CLASSIC_LOCK_RR_3", 7, 5],
  ]
    .map(([triggerKey, lockKey, defaultTriggerRr, defaultLockRr]) => ({
      triggerRr: Number(config[triggerKey] || defaultTriggerRr),
      lockRr: Number(config[lockKey] || defaultLockRr),
    }))
    .filter(
      (step) =>
        Number.isFinite(step.triggerRr) &&
        step.triggerRr > 0 &&
        Number.isFinite(step.lockRr) &&
        step.lockRr >= 0,
    )
    .sort((a, b) => b.triggerRr - a.triggerRr);
}

function buildAutoClassicTrailPlan(config, context) {
  if (!Number.isFinite(context.riskPoints) || context.riskPoints <= 0) {
    return {
      eligible: false,
      logKey: "classic-waiting-risk",
      message: "AUTO_TRAIL waiting: classic risk points are unavailable",
    };
  }

  const steps = getClassicAutoTrailSteps(config);

  if (!steps.length) {
    return {
      eligible: false,
      logKey: "classic-missing-steps",
      message: "AUTO_TRAIL skipped: classic RR steps are unavailable",
    };
  }

  const currentRr = Number(
    (
      (context.currentOptionPremium - context.entryPremium) /
      context.riskPoints
    ).toFixed(2),
  );
  const selectedStep = steps.find((step) => currentRr >= step.triggerRr);

  if (!selectedStep) {
    const nextStep = steps[steps.length - 1];

    return {
      eligible: false,
      logKey: `classic-below:${currentRr}:${nextStep.triggerRr}`,
      message:
        `AUTO_TRAIL waiting: classic RR=${currentRr} ` +
        `target=1:${nextStep.triggerRr}`,
    };
  }

  const targetPremium = roundToTick(
    context.entryPremium + context.riskPoints * selectedStep.triggerRr,
    0.05,
  );
  const triggerPrice = roundToTick(
    context.entryPremium + context.riskPoints * selectedStep.lockRr,
    0.05,
  );
  const limitPrice = roundToTick(triggerPrice - context.limitBand, 0.05);

  if (triggerPrice <= context.currentStopLoss) {
    return {
      eligible: false,
      logKey:
        `classic-already-protected:${selectedStep.triggerRr}:` +
        `${triggerPrice}:${context.currentStopLoss}`,
      message:
        `AUTO_TRAIL skipped: classic lock 1:${selectedStep.lockRr} ` +
        `SL=${triggerPrice} is not above current SL=${context.currentStopLoss}`,
    };
  }

  if (!limitPrice || limitPrice <= 0 || limitPrice >= triggerPrice) {
    return {
      eligible: false,
      logKey: `classic-invalid-prices:${triggerPrice}:${limitPrice}`,
      message:
        `AUTO_TRAIL skipped: invalid classic SL-Limit prices ` +
        `trigger=${triggerPrice} limit=${limitPrice}`,
    };
  }

  return {
    eligible: true,
    triggerPrice,
    limitPrice,
    targetPremium,
    currentOptionPremium: context.currentOptionPremium,
    currentRr,
    triggerRr: selectedStep.triggerRr,
    lockRr: selectedStep.lockRr,
    logKey:
      `classic-trail:${selectedStep.triggerRr}:${selectedStep.lockRr}:` +
      `${triggerPrice}:${limitPrice}:${context.currentOptionPremium}`,
    message:
      `AUTO_TRAIL eligible: classic RR=${currentRr} reached 1:${selectedStep.triggerRr} ` +
      `lock=1:${selectedStep.lockRr} trigger=${triggerPrice} limit=${limitPrice}`,
  };
}

function buildAutoTrailPlan(config, updatedTrade) {
  const trailMode = String(config.TRAIL_MODE || "CONSERVATIVE").toUpperCase();
  const context = getAutoTrailContext(config, updatedTrade);

  if (!hasAutoTrailBaseMetrics(context)) {
    return {
      eligible: false,
      logKey: "waiting-metrics",
      message: "AUTO_TRAIL waiting: active trade premium metrics are incomplete",
    };
  }

  if (["CONSERVATIVE", "AGGRESSIVE"].includes(trailMode)) {
    return buildAutoCostToCostTrailPlan(config, context);
  }

  if (trailMode === "CLASSIC") {
    return buildAutoClassicTrailPlan(config, context);
  }

  return {
    eligible: false,
    logKey: `mode:${trailMode}`,
    message: `AUTO_TRAIL skipped: unsupported mode=${trailMode}`,
  };
}

function logAutoTrailDecision(plan, level = "info") {
  const now = Date.now();

  if (
    plan.logKey === lastAutoTrailLogKey &&
    now - lastAutoTrailLogAt < 60 * 1000
  ) {
    return;
  }

  lastAutoTrailLogKey = plan.logKey;
  lastAutoTrailLogAt = now;
  logger[level](plan.message);
}

async function runAutoTrailWorker() {
  if (autoTrailInFlight) {
    return;
  }

  const config = getRuntimeConfig();

  if (!isEnabled(config.AUTO_TRAIL_SL)) {
    return;
  }

  autoTrailInFlight = true;

  try {
    await syncActiveStopLossStatus();

    if (!currentPosition || !stopLossOrderId) {
      return;
    }

    const savedPosition = loadPosition();
    const metricsCheckedAt = Date.parse(savedPosition.currentPremiumCheckedAt || "");
    const metricsAgeMs = Number.isFinite(metricsCheckedAt)
      ? Date.now() - metricsCheckedAt
      : Infinity;
    const updatedTrade =
      metricsAgeMs <= AUTO_TRAIL_MARKET_METRICS_FRESH_MS
        ? {
            currentPremium: savedPosition.currentPremium,
            entryPrice: savedPosition.entryPremiumReference,
          }
        : await updateActiveTradeMarketMetrics("AUTO_TRAIL");
    const plan = buildAutoTrailPlan(config, updatedTrade);

    if (!plan.eligible) {
      logAutoTrailDecision(plan);
      return;
    }

    logger.info(plan.message);

    const result = await trailStopLossOrder({
      triggerPrice: plan.triggerPrice,
      limitPrice: plan.limitPrice,
      source: "AUTO",
    });

    if (!result.body.success) {
      logger.warn(
        `AUTO_TRAIL failed: status=${result.statusCode} message=${result.body.message}`,
      );
    }
  } catch (error) {
    logger.warn(`AUTO_TRAIL worker failed: ${error.message}`);
  } finally {
    autoTrailInFlight = false;
  }
}

// Merge process env with the latest .env file values written by the dashboard.
function getRuntimeConfig() {
  try {
    applyDailyControlReset(envPath, { logger });
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

function isPaperTradeMode(mode) {
  return normalizeTradeMode(mode) === "PAPER";
}

function currentPositionBelongsToMode(mode) {
  return currentPosition && normalizeTradeMode(currentPositionMode) === mode;
}

function getMatchingExitSignal(position = currentPosition) {
  return position === "LONG"
    ? "LONG_EXIT"
    : position === "SHORT"
      ? "SHORT_EXIT"
      : null;
}

function isAllowedUnderlyingSymbol(symbol) {
  return isConfiguredUnderlyingSymbol(symbol, getRuntimeConfig());
}

function getActiveUnderlyingProfile(config = getRuntimeConfig()) {
  return getUnderlyingProfile(config);
}

function isTradingViewSymbolAllowed(symbolKey, config) {
  if (symbolKey === "BANKNIFTY") {
    return config.ALLOW_BANKNIFTY_TV_SIGNALS === undefined
      ? true
      : isEnabled(config.ALLOW_BANKNIFTY_TV_SIGNALS);
  }

  if (symbolKey === "NIFTY") {
    return config.ALLOW_NIFTY_TV_SIGNALS === undefined
      ? true
      : isEnabled(config.ALLOW_NIFTY_TV_SIGNALS);
  }

  return false;
}

function getWebhookUnderlyingContext(symbol, config, manualSignal) {
  if (manualSignal) {
    const profile = getActiveUnderlyingProfile(config);

    return {
      allowed: isConfiguredUnderlyingSymbol(symbol, config),
      profile,
      config,
      reason: `Only ${profile.displayName} manual signals are allowed.`,
      response: `Non-${profile.displayName} symbol ignored\n`,
    };
  }

  const baseProfile = getUnderlyingProfileForSymbol(symbol);

  if (!baseProfile) {
    return {
      allowed: false,
      profile: getActiveUnderlyingProfile(config),
      config,
      reason: "Only NIFTY and BANKNIFTY TradingView alerts are recognized.",
      response: "Unsupported TradingView symbol ignored\n",
    };
  }

  const activeProfile = getActiveUnderlyingProfile(config);
  const symbolConfig = {
    ...config,
    UNDERLYING_SYMBOL: baseProfile.symbol,
  };

  if (baseProfile.symbol !== activeProfile.symbol) {
    delete symbolConfig.LOT_SIZE;
    delete symbolConfig.STRIKE_STEP;
    delete symbolConfig.PLANNING_SL_POINTS;
  }

  const profile = getUnderlyingProfile(symbolConfig);
  symbolConfig.LOT_SIZE = String(profile.lotSize);
  symbolConfig.STRIKE_STEP = String(profile.strikeStep);
  symbolConfig.PLANNING_SL_POINTS = String(profile.planningSlPoints);

  if (!isTradingViewSymbolAllowed(profile.symbol, config)) {
    return {
      allowed: false,
      profile,
      config: symbolConfig,
      reason: `${profile.displayName} TradingView signals are disabled from Trading Desk.`,
      response: `${profile.displayName} TradingView signals disabled\n`,
    };
  }

  return {
    allowed: true,
    profile,
    config: symbolConfig,
  };
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

function clearWebhookDedupe(payload) {
  const key = getWebhookDedupeKey(payload);

  if (key) {
    recentWebhookSignals.delete(key);
  }
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

function getTradingViewTimeframeKey(intervalMinutes) {
  return {
    1: "ALLOW_TV_TIMEFRAME_1M",
    3: "ALLOW_TV_TIMEFRAME_3M",
    5: "ALLOW_TV_TIMEFRAME_5M",
    15: "ALLOW_TV_TIMEFRAME_15M",
    30: "ALLOW_TV_TIMEFRAME_30M",
    60: "ALLOW_TV_TIMEFRAME_60M",
  }[Number(intervalMinutes)];
}

function isTradingViewTimeframeAllowed(intervalMinutes, config) {
  if (Number(intervalMinutes) === 15) {
    return true;
  }

  const key = getTradingViewTimeframeKey(intervalMinutes);

  if (!key) {
    return false;
  }

  return isEnabled(config[key]);
}

async function rejectDisabledTradingViewTimeframe(
  res,
  signal,
  symbol,
  price,
  intervalMinutes,
) {
  logger.warn(
    `${signal} ignored because TradingView timeframe ${intervalMinutes}m is disabled`,
  );

  await sendTelegram(
    `⚠️ TradingView Timeframe Disabled

Signal : ${signal}
Symbol : ${symbol}
Price  : ${price}
Timeframe : ${intervalMinutes}m

No order placed.`,
  );

  return res.status(200).send("TradingView timeframe disabled\n");
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

function isBrokerOrderInactive(orderStatus) {
  return ["CANCELLED", "REJECTED", "EXPIRED"].includes(orderStatus);
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
      orderId: getOrderId(orderResult),
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

async function confirmStopLossTrailUpdate(
  orderId,
  expectedTriggerPrice,
  expectedLimitPrice,
) {
  if (String(orderId).startsWith("PAPER-")) {
    return {
      success: true,
      paperTrade: true,
      orderId,
      status: "PENDING",
      triggerPrice: expectedTriggerPrice,
      limitPrice: expectedLimitPrice,
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
        success: false,
        executed: true,
        status,
        order,
        error: "Stop-loss order executed while trail update was being verified",
      };
    }

    if (isBrokerOrderInactive(status)) {
      return {
        success: false,
        inactive: true,
        status,
        order,
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
        order,
        error:
          `Trail modify not reflected by broker: type=${orderType || "UNKNOWN"} ` +
          `trigger=${reportedTrigger || "missing"} expectedTrigger=${expectedTriggerPrice} ` +
          `limit=${reportedLimit || "missing"} expectedLimit=${expectedLimitPrice}`,
      };
    }
  }

  return {
    success: false,
    orderId,
    status: "UNCONFIRMED",
    error: "Modified stop-loss order could not be verified as pending",
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

function saveOpenPositionTrailUpdate({ triggerPrice }) {
  const existingPosition = loadPosition();

  premiumStopLoss = triggerPrice;
  const updatedTrade = updateLatestOpenTradeStopLoss({
    securityId,
    tradeMode: currentPositionMode,
    premiumStopLoss,
  });

  savePosition({
    ...existingPosition,
    currentPosition,
    tradeMode: currentPositionMode,
    securityId,
    quantity,
    optionSymbol,
    stopLossOrderId,
    premiumStopLoss,
    premiumStopLossCandle,
    capitalDeployed: updatedTrade?.capitalDeployed || existingPosition.capitalDeployed,
    stopLossMoney: updatedTrade?.stopLossMoney || existingPosition.stopLossMoney,
    riskPoints: updatedTrade?.riskPoints || existingPosition.riskPoints,
    currentPremium: updatedTrade?.currentPremium || existingPosition.currentPremium,
    currentPremiumCheckedAt:
      updatedTrade?.currentPremiumCheckedAt ||
      existingPosition.currentPremiumCheckedAt,
    runningProfitAmount:
      updatedTrade?.runningProfitAmount ?? existingPosition.runningProfitAmount,
    runningProfitPercent:
      updatedTrade?.runningProfitPercent ?? existingPosition.runningProfitPercent,
    riskRewardRatio:
      updatedTrade?.riskRewardRatio ?? existingPosition.riskRewardRatio,
    riskReward: updatedTrade?.riskReward || existingPosition.riskReward,
  });
}

async function updateActiveTradeMarketMetrics(source = "POLL") {
  if (!currentPosition || !securityId || !quantity) {
    return null;
  }

  try {
    const quote = await getOptionLtp({
      SEM_SMST_SECURITY_ID: securityId,
      SEM_INSTRUMENT_NAME: "OPTIDX",
    });
    const updatedTrade = updateLatestOpenTradeMarket({
      securityId,
      tradeMode: currentPositionMode,
      currentPremium: quote.ltp,
    });

    if (!updatedTrade) {
      return null;
    }

    const existingPosition = loadPosition();

    savePosition({
      ...existingPosition,
      currentPosition,
      tradeMode: currentPositionMode,
      securityId,
      quantity,
      optionSymbol,
      stopLossOrderId,
      premiumStopLoss,
      premiumStopLossCandle,
      currentPremium: updatedTrade.currentPremium,
      currentPremiumCheckedAt: updatedTrade.currentPremiumCheckedAt,
      capitalDeployed: updatedTrade.capitalDeployed,
      stopLossMoney: updatedTrade.stopLossMoney,
      runningProfitAmount: updatedTrade.runningProfitAmount,
      runningProfitPercent: updatedTrade.runningProfitPercent,
      riskRewardRatio: updatedTrade.riskRewardRatio,
      riskReward: updatedTrade.riskReward,
      riskPoints: updatedTrade.riskPoints,
      riskSource: updatedTrade.riskSource || existingPosition.riskSource,
    });

    return updatedTrade;
  } catch (error) {
    const now = Date.now();

    if (now - lastMarketMetricsWarningAt > 60000) {
      lastMarketMetricsWarningAt = now;
      logger.warn(
        `Trade market metrics refresh skipped: source=${source} securityId=${securityId} ` +
          `reason=${error.message}`,
      );
    }

    return null;
  }
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
  markTradeStopLossHit({
    orderId: trackedStopLossOrderId,
    exitPrice: getExecutedPrice(result, premiumStopLoss),
  });
  clearOpenPosition();
}

async function cancelStaleStopLossAfterBrokerFlat({
  trackedStopLossOrderId,
  trackedOptionSymbol,
  source,
}) {
  if (!trackedStopLossOrderId) {
    return {
      success: true,
      skipped: true,
    };
  }

  const statusResult = await getOrderStatus(trackedStopLossOrderId);

  if (statusResult.success) {
    const orderStatus = getBrokerOrderStatus(statusResult);

    if (isBrokerOrderExecuted(orderStatus)) {
      markTradeStopLossHit({
        orderId: trackedStopLossOrderId,
        exitPrice: getExecutedPrice(statusResult, premiumStopLoss),
      });
      clearOpenPosition();

      await sendTelegram(
        `✅ Stop Loss Executed

Broker sync source :
${source}

Contract :
${trackedOptionSymbol}

Stop Loss Order ID :
${trackedStopLossOrderId}

Bot position cleared.`,
      );

      return {
        success: true,
        stopLossExecuted: true,
      };
    }

    if (isBrokerOrderInactive(orderStatus)) {
      logger.warn(
        `Broker-flat sync found protective SL ${trackedStopLossOrderId} already ${orderStatus}`,
      );

      return {
        success: true,
        alreadyInactive: true,
        status: orderStatus,
      };
    }
  }

  const cancelResult = await cancelOrder(trackedStopLossOrderId);

  if (!cancelResult.success && !isAlreadyCancelledError(cancelResult)) {
    logger.warn(
      `Broker-flat sync could not cancel stale protective SL ${trackedStopLossOrderId}: ${JSON.stringify(cancelResult.error)}`,
    );

    await sendTelegram(
      `⚠️ Stale Stop Loss Cancel Failed

Dhan positions show the tracked bot position is already flat, but the bot could not cancel the old protective SL order.

Contract :
${trackedOptionSymbol}

Stop Loss Order ID :
${trackedStopLossOrderId}

Reason:
${JSON.stringify(cancelResult.error, null, 2)}

Please check Dhan orders manually.`,
    );

    return {
      success: false,
      error: cancelResult.error,
    };
  }

  logger.info(
    `Broker-flat sync cancelled stale protective SL ${trackedStopLossOrderId}`,
  );

  return {
    success: true,
    cancelled: true,
    alreadyCancelled: isAlreadyCancelledError(cancelResult),
  };
}

async function syncActiveBrokerPosition(source = "AUTO") {
  if (brokerPositionSyncInFlight) {
    return {
      synced: false,
      skipped: true,
      reason: "sync already running",
    };
  }

  brokerPositionSyncInFlight = true;

  try {
    return await reconcileActiveBrokerPosition(source);
  } finally {
    brokerPositionSyncInFlight = false;
  }
}

async function reconcileActiveBrokerPosition(source = "AUTO") {
  if (!currentPosition || !securityId) {
    return {
      synced: false,
      skipped: true,
    };
  }

  const activeTradeMode = normalizeTradeMode(currentPositionMode);

  if (activeTradeMode === "PAPER") {
    return {
      synced: false,
      skipped: true,
      reason: "paper trade",
    };
  }

  const trackedPosition = currentPosition;
  const trackedSecurityId = securityId;
  const trackedQuantity = quantity;
  const trackedOptionSymbol = optionSymbol;
  const trackedStopLossOrderId = stopLossOrderId;
  const brokerPosition = await getBrokerOpenQuantityForSecurity(trackedSecurityId);

  if (!brokerPosition.success) {
    logger.warn(
      `Broker position sync skipped because Dhan position check failed: ${JSON.stringify(brokerPosition.error)}`,
    );

    return {
      synced: false,
      error: brokerPosition.error,
    };
  }

  if (brokerPosition.quantity > 0) {
    return {
      synced: false,
      brokerQuantity: brokerPosition.quantity,
    };
  }

  logger.warn(
    `Broker position sync clearing ${trackedPosition}; Dhan shows zero open quantity for securityId=${trackedSecurityId}`,
  );

  const stopLossCleanup = await cancelStaleStopLossAfterBrokerFlat({
    trackedStopLossOrderId,
    trackedOptionSymbol,
    source,
  });

  if (stopLossCleanup.stopLossExecuted) {
    return {
      synced: true,
      stopLossExecuted: true,
    };
  }

  markLatestOpenTradeExited({
    signal: "BROKER_POSITION_FLAT",
    exitOrderId: null,
    manual: true,
    tradeMode: activeTradeMode,
  });
  clearOpenPosition();

  await sendTelegram(
    `⚠️ Bot Position Synced Flat

Dhan positions show no open quantity for the bot-tracked option. This usually means the position was closed manually on Dhan.

Contract :
${trackedOptionSymbol}

Security ID :
${trackedSecurityId}

Tracked Qty :
${trackedQuantity}

Protective SL :
${trackedStopLossOrderId || "-"}

Source :
${source}

Bot dashboard position cleared.`,
  );

  return {
    synced: true,
    brokerQuantity: brokerPosition.quantity,
    stopLossCleanup,
  };
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
    NIFTY: {
      1: 6,
      3: 12,
      5: 15,
      15: 25,
      30: 40,
    },
    BANKNIFTY: {
      1: 10,
      3: 15,
      5: 20,
      15: 40,
      30: 70,
    },
  };
  const intervalNumber = Number(interval);
  const field = {
    1: { activeKey: "PREMIUM_HUGE_CANDLE_1M", suffix: "1M" },
    3: { activeKey: "PREMIUM_HUGE_CANDLE_3M", suffix: "3M" },
    5: { activeKey: "PREMIUM_HUGE_CANDLE_5M", suffix: "5M" },
    15: { activeKey: "PREMIUM_HUGE_CANDLE_15M", suffix: "15M" },
    30: { activeKey: "PREMIUM_HUGE_CANDLE_30M", suffix: "30M" },
  }[intervalNumber];

  if (!field) {
    return null;
  }

  const underlyingSymbol =
    String(config.UNDERLYING_SYMBOL || "").toUpperCase() === "BANKNIFTY"
      ? "BANKNIFTY"
      : "NIFTY";
  const symbolKey = underlyingSymbol + "_PREMIUM_HUGE_CANDLE_" + field.suffix;
  const symbolConfigured = Number(config[symbolKey]);

  if (Number.isFinite(symbolConfigured) && symbolConfigured > 0) {
    return symbolConfigured;
  }

  const genericConfigured = Number(config[field.activeKey]);

  if (
    underlyingSymbol === "NIFTY" &&
    Number.isFinite(genericConfigured) &&
    genericConfigured > 0
  ) {
    return genericConfigured;
  }

  return defaults[underlyingSymbol][intervalNumber];
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

function getPremiumStopLossFailureReason(result) {
  const reason = result?.error || result;

  return typeof reason === "string" ? reason : JSON.stringify(reason);
}

function getPremiumStopLossFailureDetails(result, context = {}) {
  const details = [
    `reason=${getPremiumStopLossFailureReason(result)}`,
  ];

  if (context.contract?.SEM_CUSTOM_SYMBOL) {
    details.push(`contract=${context.contract.SEM_CUSTOM_SYMBOL}`);
  }

  if (context.contract?.SEM_SMST_SECURITY_ID) {
    details.push(`securityId=${context.contract.SEM_SMST_SECURITY_ID}`);
  }

  if (result?.entryPremium != null) {
    details.push(`optionLtp=${result.entryPremium}`);
  }

  if (result?.stopLossPremium != null) {
    details.push(`premiumSL=${result.stopLossPremium}`);
  }

  if (context.stopLossPlan?.candle?.low != null) {
    details.push(`previousCandleLow=${context.stopLossPlan.candle.low}`);
  }

  if (context.stopLossPlan?.candle?.high != null) {
    details.push(`previousCandleHigh=${context.stopLossPlan.candle.high}`);
  }

  if (context.stopLossPlan?.candleRange != null) {
    details.push(`previousCandleRange=${context.stopLossPlan.candleRange}`);
  }

  if (context.stopLossPlan?.interval != null) {
    details.push(`interval=${context.stopLossPlan.interval}`);
  }

  return details.join(" ");
}

async function rejectPremiumStopLossFailure(
  res,
  signal,
  symbol,
  price,
  result,
  context = {},
) {
  const reasonText =
    typeof result.error === "string"
      ? result.error
      : JSON.stringify(result.error || result);

  logger.warn(
    `${signal} ignored because premium stop-loss setup failed: ` +
      getPremiumStopLossFailureDetails(result, context),
  );

  await sendTelegram(
    `❌ Premium Stop Loss Setup Failed

Signal : ${signal}
Symbol : ${symbol}
Price  : ${price}
Contract : ${context.contract?.SEM_CUSTOM_SYMBOL || "-"}
Security ID : ${context.contract?.SEM_SMST_SECURITY_ID || "-"}
Option LTP : ${result.entryPremium ?? "-"}
Premium SL : ${result.stopLossPremium ?? context.stopLossPlan?.triggerPrice ?? "-"}
Previous Candle Low : ${context.stopLossPlan?.candle?.low ?? "-"}
Previous Candle High : ${context.stopLossPlan?.candle?.high ?? "-"}

Reason:
${JSON.stringify(result.error || result, null, 2)}

No entry order placed.`,
  );

  if (context.manualSignal) {
    return res.status(200).json({
      success: false,
      code: "PREMIUM_STOP_LOSS_SETUP_FAILED",
      message:
        "Entry premium is already below the planned SL level. Please confirm LONG or SHORT entry.",
      reason: reasonText,
      signal,
      symbol,
      price,
      contract: context.contract?.SEM_CUSTOM_SYMBOL || null,
      securityId: context.contract?.SEM_SMST_SECURITY_ID || null,
      optionLtp: result.entryPremium ?? null,
      premiumSl:
        result.stopLossPremium ?? context.stopLossPlan?.triggerPrice ?? null,
      previousCandleLow: context.stopLossPlan?.candle?.low ?? null,
      previousCandleHigh: context.stopLossPlan?.candle?.high ?? null,
    });
  }

  return res.status(200).send("Premium stop loss setup failed\n");
}

function getEntrySizing(signal, config, riskPoints, contract) {
  return calculateLots({
    signal,
    riskPoints,
    settings: {
      ...config,
      CONTRACT_EXPIRY_DATE: contract?.SEM_EXPIRY_DATE,
    },
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

function getPaperSizingRiskPoints(config, result) {
  const plannedRiskPoints = Number(config.PLANNING_SL_POINTS || 0);

  if (Number.isFinite(plannedRiskPoints) && plannedRiskPoints > 0) {
    return plannedRiskPoints;
  }

  const entryPremium = Number(result.entryPremium);
  const stopLossPremium = Number(result.stopLossPremium);
  const premiumDistance = Math.abs(entryPremium - stopLossPremium);

  return Number.isFinite(premiumDistance) && premiumDistance > 0
    ? Number(premiumDistance.toFixed(2))
    : getMinimumPremiumSlPoints(config);
}

function canSimulatePaperPremiumSlFailure(activeTradeMode, result) {
  return (
    isPaperTradeMode(activeTradeMode) &&
    Number.isFinite(Number(result.entryPremium)) &&
    Number.isFinite(Number(result.stopLossPremium))
  );
}

function createPaperPremiumSlWarning({
  config,
  result,
  reason,
  source = "PAPER_PREMIUM_SL_WARNING",
}) {
  const entryPremium = Number(result.entryPremium);
  const stopLossPremium = Number(result.stopLossPremium);
  const actualRiskPoints = Number((entryPremium - stopLossPremium).toFixed(2));
  const sizingRiskPoints = getPaperSizingRiskPoints(config, result);

  return {
    code: "PAPER_PREMIUM_SL_INVALID_AT_ENTRY",
    source,
    message: reason,
    entryPremium,
    stopLossPremium,
    actualRiskPoints,
    sizingRiskPoints,
  };
}

function getPaperRiskPlanFromWarning(warning, result) {
  return {
    success: true,
    source: warning.source,
    riskPoints: warning.sizingRiskPoints,
    entryPremium: warning.entryPremium,
    stopLossPremium: warning.stopLossPremium,
    paperWarning: warning,
    checkedAt: result.checkedAt,
  };
}

function logPaperPremiumSlWarning(signal, warning) {
  logger.warn(
    `${signal} PAPER entry continuing despite premium SL warning: ` +
      `reason=${warning.message} entryPremium=${warning.entryPremium} ` +
      `premiumSL=${warning.stopLossPremium} actualRiskPoints=${warning.actualRiskPoints} ` +
      `sizingRiskPoints=${warning.sizingRiskPoints}`,
  );
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

  if (!cancelResult.success && isAlreadyCancelledError(cancelResult)) {
    logger.warn(
      `${signal} continuing because protective stop-loss order ${stopLossOrderId} is already cancelled`,
    );

    return {
      ...cancelResult,
      success: true,
      alreadyCancelled: true,
    };
  }

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

async function rejectContractNotFound({
  res,
  signal,
  symbol,
  price,
  option,
  underlyingProfile,
  activeTradeMode,
}) {
  logger.warn(
    `${signal} ignored because contract not found: ` +
      `symbol=${symbol} price=${price} strike=${option.strike} ` +
      `optionType=${option.optionType} underlying=${underlyingProfile.displayName} ` +
      `tradeMode=${activeTradeMode}`,
  );

  const paperMode = isPaperTradeMode(activeTradeMode);

  await sendTelegram(
    `${paperMode ? "❌ Paper Simulation Failed - Contract Not Found" : "❌ Contract Not Found"}

Signal : ${signal}
Mode   : ${activeTradeMode}
Symbol : ${symbol}
Spot   : ${price}
Strike : ${option.strike}
Type   : ${option.optionType}

No matching ${underlyingProfile.displayName} option contract found for this spot/strike.

${paperMode ? "No paper trade created." : "No order placed."}`,
  );

  return res.status(200).send("Contract not found\n");
}

function getRiskBudgetLabel(config) {
  return String(config.RISK_MODE || "").toUpperCase() === "PER_DAY"
    ? "Risk per day"
    : "Risk per trade";
}

function formatEntryTradeTelegram({
  emoji,
  config,
  contract,
  sizing,
  quantity,
  entryPremium,
  riskPoints,
  premiumStopLoss,
  tradeLimitStatus,
  paperEntryWarning,
}) {
  const paperWarningText = paperEntryWarning
    ? `
-----------------------------
Paper Warning : ${paperEntryWarning.message}
Actual SL Distance : ${paperEntryWarning.actualRiskPoints ?? "-"}
Sizing Risk Points : ${paperEntryWarning.sizingRiskPoints ?? "-"}`
    : "";
  const expiryRiskText = sizing.expiryRiskReductionActive
    ? `
Expiry Day Risk : ${sizing.effectiveRiskPercent}% used instead of ${sizing.riskPercent}%`
    : "";

  return `${emoji} ${getTradeModeLabel(config, "TRADE")}
-----------------------------
Position : ${contract.SEM_CUSTOM_SYMBOL}
Lots : ${sizing.finalLots} (Qty : ${quantity})
-----------------------------
${getRiskBudgetLabel(config)} : ${sizing.riskAmount}
Loss Per Lot : ${sizing.lossPerLot}
${expiryRiskText}

Entry Premium : ${entryPremium || "-"}
Risk Points : ${riskPoints || "-"}
Premium SL : ${premiumStopLoss || "-"}
-----------------------------
Total Trades Today : ${tradeLimitStatus.entryCount}
${paperWarningText}

${getOrderPlacementNote(config)}`;
}

function getBrokerErrorText(result) {
  const error = result?.error;

  if (!error) {
    return "";
  }

  if (typeof error === "string") {
    return error;
  }

  return [
    error.errorType,
    error.errorCode,
    error.errorMessage,
    error.message,
  ]
    .filter(Boolean)
    .join(" ");
}

function isInsufficientFundsError(result) {
  const text = getBrokerErrorText(result).toLowerCase();

  return text.includes("insufficient funds");
}

function getLotStepDownSizing(sizing, lots) {
  const lotSize = Number(sizing.lotSize || 0);

  if (!Number.isFinite(lotSize) || lotSize <= 0 || lots <= 0) {
    return null;
  }

  return {
    ...sizing,
    finalLots: lots,
    quantity: lots * lotSize,
    fundsRetry: lots !== sizing.finalLots,
    originalFinalLots: sizing.originalFinalLots || sizing.finalLots,
    originalQuantity: sizing.originalQuantity || sizing.quantity,
  };
}

async function placeAndConfirmEntryWithFundsRetry({
  signal,
  symbol,
  price,
  contract,
  sizing,
}) {
  const startingLots = Number(sizing.finalLots || 0);
  let lastOrderResult = null;
  let lastEntryConfirmation = null;
  let lastFailureReason = "";

  for (let lots = startingLots; lots > 0; lots -= 1) {
    const attemptSizing = getLotStepDownSizing(sizing, lots);

    if (!attemptSizing?.quantity || attemptSizing.quantity <= 0) {
      continue;
    }

    if (lots < startingLots) {
      logger.warn(
        `${signal} insufficient funds at ${lots + 1} lots; retrying ${lots} lots quantity=${attemptSizing.quantity}`,
      );

      await sendTelegram(
        `⚠️ ${signal} retrying with lower quantity

Symbol : ${symbol}
Price  : ${price}

Reason:
${lastFailureReason}

Retry Lots : ${lots}
Retry Qty : ${attemptSizing.quantity}`,
      );
    }

    const orderResult = await placeMarketBuyOrder(
      contract,
      attemptSizing.quantity,
    );
    lastOrderResult = orderResult;

    console.log(orderResult);

    if (!orderResult.success) {
      lastFailureReason =
        getBrokerErrorText(orderResult) ||
        JSON.stringify(orderResult.error || "Entry order failed");

      if (isInsufficientFundsError(orderResult)) {
        continue;
      }

      return {
        orderResult,
        entryConfirmation: null,
        sizing: attemptSizing,
        quantity: attemptSizing.quantity,
      };
    }

    const entryConfirmation = await confirmEntryOrderExecution(orderResult);
    lastEntryConfirmation = entryConfirmation;

    if (entryConfirmation.success) {
      return {
        orderResult,
        entryConfirmation,
        sizing: attemptSizing,
        quantity: attemptSizing.quantity,
      };
    }

    lastFailureReason = entryConfirmation.error || "Entry order not filled";

    if (!isInsufficientFundsError(entryConfirmation)) {
      return {
        orderResult,
        entryConfirmation,
        sizing: attemptSizing,
        quantity: attemptSizing.quantity,
      };
    }
  }

  return {
    orderResult: lastOrderResult,
    entryConfirmation:
      lastEntryConfirmation || {
        success: false,
        status: "NO_AFFORDABLE_LOTS",
        error:
          lastFailureReason ||
          "Insufficient funds remained after reducing to one lot",
      },
    sizing: getLotStepDownSizing(sizing, 1) || sizing,
    quantity: getLotStepDownSizing(sizing, 1)?.quantity || sizing.quantity,
  };
}

function isAlreadyCancelledError(result) {
  const text = getBrokerErrorText(result).toLowerCase();

  return (
    text.includes("dh-906") ||
    (text.includes("order") && text.includes("cancelled"))
  );
}

function isNoBrokerPositionExitError(result) {
  const text = getBrokerErrorText(result).toLowerCase();

  return (
    text.includes("no position") ||
    text.includes("no open position") ||
    text.includes("insufficient position") ||
    text.includes("insufficient quantity") ||
    text.includes("insufficient holdings") ||
    text.includes("available quantity") ||
    text.includes("quantity available") ||
    text.includes("nothing to sell")
  );
}

function normalizeBrokerPositionList(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.positions)) {
    return data.positions;
  }

  return [];
}

function getPositionSecurityId(position) {
  return String(
    position?.securityId ||
      position?.security_id ||
      position?.drvSecurityId ||
      position?.dhanSecurityId ||
      "",
  );
}

function getPositionOpenQuantity(position) {
  const quantityFields = [
    position?.netQty,
    position?.netQuantity,
    position?.quantity,
    position?.openQty,
    position?.dayBuyQty != null || position?.daySellQty != null
      ? Number(position?.dayBuyQty || 0) - Number(position?.daySellQty || 0)
      : null,
    position?.buyQty != null || position?.sellQty != null
      ? Number(position?.buyQty || 0) - Number(position?.sellQty || 0)
      : null,
  ];

  for (const value of quantityFields) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

async function getBrokerOpenQuantityForSecurity(securityIdToCheck) {
  const result = await getPositions();

  if (!result.success) {
    return {
      success: false,
      error: result.error,
    };
  }

  const positions = normalizeBrokerPositionList(result.data);
  const matchingPosition = positions.find(
    (position) => getPositionSecurityId(position) === String(securityIdToCheck),
  );

  if (!matchingPosition) {
    return {
      success: true,
      quantity: 0,
      position: null,
    };
  }

  return {
    success: true,
    quantity: getPositionOpenQuantity(matchingPosition),
    position: matchingPosition,
  };
}

async function syncManualExitAlreadyFlat({
  signal,
  activeTradeMode,
  exitOptionSymbol,
  exitSecurityId,
  exitQuantity,
  exitResult,
}) {
  logger.warn(
    `${signal} broker rejected SELL as already flat; clearing local position for ${exitOptionSymbol}`,
  );

  markLatestOpenTradeExited({
    signal,
    exitOrderId: getOrderId(exitResult),
    manual: true,
    tradeMode: activeTradeMode,
  });
  clearOpenPosition();

  await sendTelegram(
    `⚠️ ${signal} synced to FLAT

Dhan rejected the bot SELL in a way that indicates the broker position is already closed.

Contract :
${exitOptionSymbol}

Security ID :
${exitSecurityId}

Qty :
${exitQuantity}

Reason:
${JSON.stringify(exitResult.error, null, 2)}

Bot position cleared.`,
  );
}

async function guardExitAgainstBrokerFlat({
  signal,
  activeTradeMode,
  exitOptionSymbol,
  exitSecurityId,
  exitQuantity,
}) {
  if (activeTradeMode === "PAPER") {
    return {
      success: true,
      exitQuantity,
    };
  }

  const brokerPosition = await getBrokerOpenQuantityForSecurity(exitSecurityId);

  if (!brokerPosition.success) {
    logger.warn(
      `${signal} blocked because broker position check failed: ${JSON.stringify(brokerPosition.error)}`,
    );

    await sendTelegram(
      `❌ ${signal} blocked

Could not verify the current Dhan position before placing SELL.

Contract :
${exitOptionSymbol}

Security ID :
${exitSecurityId}

Reason:
${JSON.stringify(brokerPosition.error, null, 2)}

Position still marked OPEN. No SELL order placed.`,
    );

    return {
      success: false,
      responseText: `${signal} broker position check failed\n`,
    };
  }

  if (brokerPosition.quantity <= 0) {
    await syncManualExitAlreadyFlat({
      signal,
      activeTradeMode,
      exitOptionSymbol,
      exitSecurityId,
      exitQuantity,
      exitResult: {
        success: false,
        error: {
          errorMessage:
            "Dhan positions show no open long quantity for this security",
          brokerQuantity: brokerPosition.quantity,
        },
      },
    });

    return {
      success: false,
      responseText: `${signal} synced flat\n`,
      syncedFlat: true,
    };
  }

  const verifiedExitQuantity = Math.min(
    Number(exitQuantity),
    Number(brokerPosition.quantity),
  );

  if (verifiedExitQuantity !== Number(exitQuantity)) {
    logger.warn(
      `${signal} reducing exit quantity from ${exitQuantity} to broker quantity ${verifiedExitQuantity}`,
    );
  }

  return {
    success: true,
    exitQuantity: verifiedExitQuantity,
  };
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

    let config = getRuntimeConfig();
    const effectiveInterval = normalizeAlertIntervalMinutes(
      alertInterval,
      config.PREMIUM_SL_INTERVAL || 15,
    );
    const underlyingContext = getWebhookUnderlyingContext(
      symbol,
      config,
      manualSignal,
    );
    const underlyingProfile = underlyingContext.profile;
    config = underlyingContext.config;

    if (!underlyingContext.allowed) {
      logger.warn(
        `Webhook ignored for ${symbol}: ${underlyingContext.reason}`,
      );

      await sendTelegram(
        `⚠️ Signal Ignored

Signal : ${signal}
Symbol : ${symbol}
Price  : ${price}

${underlyingContext.reason}

No order placed.`,
      );

      return res.status(200).send(underlyingContext.response);
    }

    if (
      !manualSignal &&
      !isTradingViewTimeframeAllowed(effectiveInterval, underlyingContext.config)
    ) {
      return rejectDisabledTradingViewTimeframe(
        res,
        signal,
        symbol,
        price,
        effectiveInterval,
      );
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
    const activeTradeMode = getTradeMode(config);
    await syncActiveStopLossStatus();
    await syncActiveBrokerPosition("WEBHOOK");

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

          const option = getOptionDetails(signal, price, underlyingProfile);

          // Convert signal direction and spot price into a tradable index option contract.
          const contract = getIndexOption(
            option.strike,
            option.optionType,
            underlyingProfile,
          );

          if (!contract) {
            return rejectContractNotFound({
              res,
              signal,
              symbol,
              price,
              option,
              underlyingProfile,
              activeTradeMode,
            });
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
              { contract, stopLossPlan, manualSignal },
            );
          }

          let paperEntryWarning = null;
          let riskPlan = await getEntryRiskPlan(
            contract,
            config,
            stopLossPlan,
          );

          if (!riskPlan.success) {
            if (
              canSimulatePaperPremiumSlFailure(activeTradeMode, riskPlan)
            ) {
              paperEntryWarning = createPaperPremiumSlWarning({
                config,
                result: riskPlan,
                reason: riskPlan.error,
                source: "PAPER_PREMIUM_SL_BELOW_ENTRY",
              });
              logPaperPremiumSlWarning(signal, paperEntryWarning);
              riskPlan = getPaperRiskPlanFromWarning(
                paperEntryWarning,
                riskPlan,
              );
            } else {
            return rejectPremiumStopLossFailure(
              res,
              signal,
              symbol,
              price,
              riskPlan,
              { contract, stopLossPlan, manualSignal },
            );
            }
          }

          const minimumPremiumSlPoints =
            getMinimumPremiumSlPoints(config);

          if (
            stopLossPlan &&
            riskPlan.riskPoints < minimumPremiumSlPoints
          ) {
            const minimumDistanceFailure = {
              error:
                `Premium SL distance ${riskPlan.riskPoints} is below minimum ` +
                `${minimumPremiumSlPoints}`,
              entryPremium: riskPlan.entryPremium,
              stopLossPremium: riskPlan.stopLossPremium,
              checkedAt: riskPlan.checkedAt,
            };

            if (
              canSimulatePaperPremiumSlFailure(
                activeTradeMode,
                minimumDistanceFailure,
              )
            ) {
              paperEntryWarning = createPaperPremiumSlWarning({
                config,
                result: minimumDistanceFailure,
                reason: minimumDistanceFailure.error,
                source: "PAPER_PREMIUM_SL_MIN_DISTANCE",
              });
              logPaperPremiumSlWarning(signal, paperEntryWarning);
              riskPlan = getPaperRiskPlanFromWarning(
                paperEntryWarning,
                minimumDistanceFailure,
              );
            } else {
            return rejectPremiumStopLossFailure(
              res,
              signal,
              symbol,
              price,
              minimumDistanceFailure,
              { contract, stopLossPlan, manualSignal },
            );
            }
          }

          let sizing = getEntrySizing(
            signal,
            config,
            riskPlan.riskPoints,
            contract,
          );

          logger.info(
            `Entry sizing: source=${riskPlan.source} premium=${riskPlan.entryPremium ?? "n/a"} premiumSL=${riskPlan.stopLossPremium ?? "n/a"} candleLow=${stopLossPlan?.candle?.low ?? "n/a"} candleHigh=${stopLossPlan?.candle?.high ?? "n/a"} candleRange=${stopLossPlan?.candleRange ?? "n/a"} halfCandle=${stopLossPlan?.hugeCandleAdjusted ?? false} hugeThreshold=${stopLossPlan?.hugeCandleThreshold ?? "n/a"} expiryRiskReduction=${sizing.expiryRiskReductionActive ?? false} riskPercent=${sizing.riskPercent} effectiveRiskPercent=${sizing.effectiveRiskPercent ?? sizing.riskPercent} riskPoints=${sizing.riskPoints} riskAmount=${sizing.riskAmount} lossPerLot=${sizing.lossPerLot} baseLots=${sizing.lots} lots=${sizing.finalLots} quantity=${sizing.quantity}`,
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

          const entryAttempt = await placeAndConfirmEntryWithFundsRetry({
            signal,
            symbol,
            price,
            contract,
            sizing,
          });
          let orderResult = entryAttempt.orderResult;
          let entryConfirmation = entryAttempt.entryConfirmation;
          sizing = entryAttempt.sizing;
          quantity = entryAttempt.quantity;

          if (!orderResult.success) {
            clearWebhookDedupe({ signal, symbol, time });
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

          if (!entryConfirmation.success) {
            clearWebhookDedupe({ signal, symbol, time });
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
            if (isPaperTradeMode(activeTradeMode)) {
              paperEntryWarning = createPaperPremiumSlWarning({
                config,
                result: {
                  entryPremium: actualEntryFillPrice,
                  stopLossPremium: stopLossPlan.triggerPrice,
                },
                reason:
                  `Actual fill-to-SL distance ${actualRiskPoints} is below minimum ` +
                  `${minimumPremiumSlPoints}`,
                source: "PAPER_ACTUAL_FILL_SL_MIN_DISTANCE",
              });
              logPaperPremiumSlWarning(signal, paperEntryWarning);
            } else {
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
            markTradeStopLossHit({
              orderId: stopLossOrderId,
              exitPrice: getExecutedPrice(slVerification, premiumStopLoss),
            });
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
              markTradeStopLossHit({
                orderId: stopLossOrderId,
                exitPrice: getExecutedPrice(executedStopLoss, premiumStopLoss),
              });
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
            entryWarningCode: paperEntryWarning?.code,
            entryWarning: paperEntryWarning?.message,
            entryWarningDetails: paperEntryWarning,
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
            entryWarningCode: paperEntryWarning?.code,
            entryWarning: paperEntryWarning?.message,
            entryWarningDetails: paperEntryWarning,
          });

          const tradeLimitStatus = recordSuccessfulEntry(activeTradeMode);

          await sendTelegram(
            formatEntryTradeTelegram({
              emoji,
              config,
              contract,
              sizing,
              quantity,
              entryPremium: actualEntryFillPrice,
              riskPoints: stopLossPlan ? actualRiskPoints : sizing.riskPoints,
              premiumStopLoss,
              tradeLimitStatus,
              paperEntryWarning,
            }),
          );

          break;
        } catch (err) {
          clearWebhookDedupe({ signal, symbol, time });
          logger.error(`LONG_ENTRY FAILED symbol=${symbol}`, err);
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

          const option = getOptionDetails(signal, price, underlyingProfile);

          // SHORT_ENTRY maps to a PE contract in optionSelector.
          const contract = getIndexOption(
            option.strike,
            option.optionType,
            underlyingProfile,
          );

          if (!contract) {
            return rejectContractNotFound({
              res,
              signal,
              symbol,
              price,
              option,
              underlyingProfile,
              activeTradeMode,
            });
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
              { contract, stopLossPlan, manualSignal },
            );
          }

          let paperEntryWarning = null;
          let riskPlan = await getEntryRiskPlan(
            contract,
            config,
            stopLossPlan,
          );

          if (!riskPlan.success) {
            if (
              canSimulatePaperPremiumSlFailure(activeTradeMode, riskPlan)
            ) {
              paperEntryWarning = createPaperPremiumSlWarning({
                config,
                result: riskPlan,
                reason: riskPlan.error,
                source: "PAPER_PREMIUM_SL_BELOW_ENTRY",
              });
              logPaperPremiumSlWarning(signal, paperEntryWarning);
              riskPlan = getPaperRiskPlanFromWarning(
                paperEntryWarning,
                riskPlan,
              );
            } else {
            return rejectPremiumStopLossFailure(
              res,
              signal,
              symbol,
              price,
              riskPlan,
              { contract, stopLossPlan, manualSignal },
            );
            }
          }

          const minimumPremiumSlPoints =
            getMinimumPremiumSlPoints(config);

          if (
            stopLossPlan &&
            riskPlan.riskPoints < minimumPremiumSlPoints
          ) {
            const minimumDistanceFailure = {
              error:
                `Premium SL distance ${riskPlan.riskPoints} is below minimum ` +
                `${minimumPremiumSlPoints}`,
              entryPremium: riskPlan.entryPremium,
              stopLossPremium: riskPlan.stopLossPremium,
              checkedAt: riskPlan.checkedAt,
            };

            if (
              canSimulatePaperPremiumSlFailure(
                activeTradeMode,
                minimumDistanceFailure,
              )
            ) {
              paperEntryWarning = createPaperPremiumSlWarning({
                config,
                result: minimumDistanceFailure,
                reason: minimumDistanceFailure.error,
                source: "PAPER_PREMIUM_SL_MIN_DISTANCE",
              });
              logPaperPremiumSlWarning(signal, paperEntryWarning);
              riskPlan = getPaperRiskPlanFromWarning(
                paperEntryWarning,
                minimumDistanceFailure,
              );
            } else {
            return rejectPremiumStopLossFailure(
              res,
              signal,
              symbol,
              price,
              minimumDistanceFailure,
              { contract, stopLossPlan, manualSignal },
            );
            }
          }

          let sizing = getEntrySizing(
            signal,
            config,
            riskPlan.riskPoints,
            contract,
          );

          logger.info(
            `Entry sizing: source=${riskPlan.source} premium=${riskPlan.entryPremium ?? "n/a"} premiumSL=${riskPlan.stopLossPremium ?? "n/a"} candleLow=${stopLossPlan?.candle?.low ?? "n/a"} candleHigh=${stopLossPlan?.candle?.high ?? "n/a"} candleRange=${stopLossPlan?.candleRange ?? "n/a"} halfCandle=${stopLossPlan?.hugeCandleAdjusted ?? false} hugeThreshold=${stopLossPlan?.hugeCandleThreshold ?? "n/a"} expiryRiskReduction=${sizing.expiryRiskReductionActive ?? false} riskPercent=${sizing.riskPercent} effectiveRiskPercent=${sizing.effectiveRiskPercent ?? sizing.riskPercent} riskPoints=${sizing.riskPoints} riskAmount=${sizing.riskAmount} lossPerLot=${sizing.lossPerLot} baseLots=${sizing.lots} lots=${sizing.finalLots} quantity=${sizing.quantity}`,
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

          const entryAttempt = await placeAndConfirmEntryWithFundsRetry({
            signal,
            symbol,
            price,
            contract,
            sizing,
          });
          let orderResult = entryAttempt.orderResult;
          let entryConfirmation = entryAttempt.entryConfirmation;
          sizing = entryAttempt.sizing;
          quantity = entryAttempt.quantity;

          if (!orderResult.success) {
            clearWebhookDedupe({ signal, symbol, time });
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

          if (!entryConfirmation.success) {
            clearWebhookDedupe({ signal, symbol, time });
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
            if (isPaperTradeMode(activeTradeMode)) {
              paperEntryWarning = createPaperPremiumSlWarning({
                config,
                result: {
                  entryPremium: actualEntryFillPrice,
                  stopLossPremium: stopLossPlan.triggerPrice,
                },
                reason:
                  `Actual fill-to-SL distance ${actualRiskPoints} is below minimum ` +
                  `${minimumPremiumSlPoints}`,
                source: "PAPER_ACTUAL_FILL_SL_MIN_DISTANCE",
              });
              logPaperPremiumSlWarning(signal, paperEntryWarning);
            } else {
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
            markTradeStopLossHit({
              orderId: stopLossOrderId,
              exitPrice: getExecutedPrice(slVerification, premiumStopLoss),
            });
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
              markTradeStopLossHit({
                orderId: stopLossOrderId,
                exitPrice: getExecutedPrice(executedStopLoss, premiumStopLoss),
              });
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
            entryWarningCode: paperEntryWarning?.code,
            entryWarning: paperEntryWarning?.message,
            entryWarningDetails: paperEntryWarning,
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
            entryWarningCode: paperEntryWarning?.code,
            entryWarning: paperEntryWarning?.message,
            entryWarningDetails: paperEntryWarning,
          });

          const tradeLimitStatus = recordSuccessfulEntry(activeTradeMode);

          await sendTelegram(
            formatEntryTradeTelegram({
              emoji,
              config,
              contract,
              sizing,
              quantity,
              entryPremium: actualEntryFillPrice,
              riskPoints: stopLossPlan ? actualRiskPoints : sizing.riskPoints,
              premiumStopLoss,
              tradeLimitStatus,
              paperEntryWarning,
            }),
          );

          break;
        } catch (err) {
          clearWebhookDedupe({ signal, symbol, time });
          logger.error(`SHORT_ENTRY FAILED symbol=${symbol}`, err);
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
          logger.warn(
            `LONG_EXIT ignored because no LONG position is open: ` +
              `currentPosition=${currentPosition || "NONE"} ` +
              `currentMode=${normalizeTradeMode(currentPositionMode) || "NONE"} ` +
              `signalMode=${activeTradeMode} ` +
              `matchingExit=${getMatchingExitSignal() || "NONE"}`,
          );
          return res.status(200).send("No LONG position");
        }

        console.log("EXIT SECURITY ID =", securityId);
        console.log("EXIT QUANTITY =", quantity);

        const exitSecurityId = securityId;
        let exitQuantity = quantity;
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

        const brokerExitGuard = await guardExitAgainstBrokerFlat({
          signal,
          activeTradeMode,
          exitOptionSymbol,
          exitSecurityId,
          exitQuantity,
        });

        if (!brokerExitGuard.success) {
          return res
            .status(200)
            .send(brokerExitGuard.responseText || "Broker position check failed\n");
        }

        exitQuantity = brokerExitGuard.exitQuantity;

        // Attempt the broker/paper SELL before changing local position state.
        const exitResult = await placeMarketSellOrder(
          exitSecurityId,
          exitQuantity,
        );
        console.log(exitResult);

        // If Dhan rejects the exit, keep the bot position open for retry/manual action.
        if (!exitResult.success) {
          if (manualSignal && isNoBrokerPositionExitError(exitResult)) {
            await syncManualExitAlreadyFlat({
              signal,
              activeTradeMode,
              exitOptionSymbol,
              exitSecurityId,
              exitQuantity,
              exitResult,
            });

            return res.status(200).send("LONG_EXIT synced flat\n");
          }

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
          manual: manualSignal,
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
          logger.warn(
            `SHORT_EXIT ignored because no SHORT position is open: ` +
              `currentPosition=${currentPosition || "NONE"} ` +
              `currentMode=${normalizeTradeMode(currentPositionMode) || "NONE"} ` +
              `signalMode=${activeTradeMode} ` +
              `matchingExit=${getMatchingExitSignal() || "NONE"}`,
          );
          return res.status(200).send("No SHORT position");
        }

        console.log("EXIT SECURITY ID =", securityId);
        console.log("EXIT QUANTITY =", quantity);

        const exitSecurityId = securityId;
        let exitQuantity = quantity;
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

        const brokerExitGuard = await guardExitAgainstBrokerFlat({
          signal,
          activeTradeMode,
          exitOptionSymbol,
          exitSecurityId,
          exitQuantity,
        });

        if (!brokerExitGuard.success) {
          return res
            .status(200)
            .send(brokerExitGuard.responseText || "Broker position check failed\n");
        }

        exitQuantity = brokerExitGuard.exitQuantity;

        // Attempt the broker/paper SELL before changing local position state.
        const exitResult = await placeMarketSellOrder(
          exitSecurityId,
          exitQuantity,
        );

        console.log(exitResult);

        // If Dhan rejects the exit, keep the bot position open for retry/manual action.
        if (!exitResult.success) {
          if (manualSignal && isNoBrokerPositionExitError(exitResult)) {
            await syncManualExitAlreadyFlat({
              signal,
              activeTradeMode,
              exitOptionSymbol,
              exitSecurityId,
              exitQuantity,
              exitResult,
            });

            return res.status(200).send("SHORT_EXIT synced flat\n");
          }

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
          manual: manualSignal,
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

// Active underlying spot LTP endpoint used by the manual signal panel.
app.get("/nifty-spot", async (req, res) => {
  try {
    const spot = await getUnderlyingSpotLtp(getActiveUnderlyingProfile());
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

setInterval(async () => {
  try {
    await syncActiveStopLossStatus();
    await syncActiveBrokerPosition("POLL");
    await updateActiveTradeMarketMetrics("POLL");
  } catch (error) {
    logger.warn(`Broker position poll failed: ${error.message}`);
  }
}, BROKER_POSITION_SYNC_INTERVAL_MS);

setTimeout(() => {
  runAutoTrailWorker();
  setInterval(runAutoTrailWorker, AUTO_TRAIL_INTERVAL_MS);
}, Math.min(5000, AUTO_TRAIL_INTERVAL_MS)).unref();

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
