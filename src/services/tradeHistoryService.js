/*
 * Maintains a compact per-day trade history for dashboard visibility.
 * Each successful entry creates one trade row with its entry, quantity, option,
 * and optional protective stop-loss order id.
 * Later exits or broker stop-loss execution update that row's outcome.
 * The dashboard reads the latest rows to show "1st Trade: Running / SL hit".
 */
const fs = require("fs");
const path = require("path");
const { getIstDateKey, normalizeTradeMode } = require("./tradeLimitService");

const tradeHistoryFile = path.join(__dirname, "../data/tradeHistory.json");

function nowIso() {
  return new Date().toISOString();
}

function getEmptyHistory(date = getIstDateKey()) {
  return {
    date,
    trades: [],
  };
}

function loadTradeHistory() {
  try {
    const data = fs.readFileSync(tradeHistoryFile, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return getEmptyHistory();
  }
}

function saveTradeHistory(history) {
  fs.writeFileSync(tradeHistoryFile, JSON.stringify(history, null, 2));
}

function getTradeHistoryForToday() {
  const today = getIstDateKey();
  const history = loadTradeHistory();

  if (history.date !== today) {
    const resetHistory = getEmptyHistory(today);
    saveTradeHistory(resetHistory);
    return resetHistory;
  }

  return {
    date: today,
    trades: Array.isArray(history.trades) ? history.trades : [],
  };
}

function getOrdinalLabel(sequence) {
  const n = Number(sequence || 0);
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";

  return `${n}${suffix} Trade`;
}

function getDisplayStatus(status) {
  switch (status) {
    case "SL_HIT":
      return "SL hit";

    case "MANUAL_EXIT":
      return "Manual exit";

    case "EXITED":
      return "Exited";

    case "CANCELLED":
      return "Cancelled";

    case "FAILED":
      return "Failed";

    case "RUNNING_UNPROTECTED":
      return "Running - no SL";

    case "RUNNING":
    default:
      return "Running";
  }
}

function roundMoney(value) {
  const number = Number(value);

  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

function roundPercent(value) {
  const number = Number(value);

  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

function getTradeEntryPremium(trade) {
  return Number(trade.entryPrice || trade.entryPremiumReference || 0);
}

function calculateTradeMetrics({
  quantity,
  entryPremium,
  stopLossPremium,
  currentPremium,
  previousMetrics = {},
}) {
  const parsedQuantity = Number(quantity);
  const parsedEntryPremium = Number(entryPremium);
  const parsedStopLossPremium = Number(stopLossPremium);
  const parsedCurrentPremium = Number(currentPremium);
  const capitalDeployed =
    Number.isFinite(parsedQuantity) &&
    parsedQuantity > 0 &&
    Number.isFinite(parsedEntryPremium) &&
    parsedEntryPremium > 0
      ? roundMoney(parsedQuantity * parsedEntryPremium)
      : null;
  const stopLossMoney =
    Number.isFinite(parsedQuantity) &&
    parsedQuantity > 0 &&
    Number.isFinite(parsedEntryPremium) &&
    parsedEntryPremium > 0 &&
    Number.isFinite(parsedStopLossPremium) &&
    parsedStopLossPremium > 0
      ? roundMoney(
          parsedQuantity * parsedEntryPremium -
            parsedQuantity * parsedStopLossPremium,
        )
      : null;
  const calculatedRiskPoints =
    Number.isFinite(parsedEntryPremium) &&
    Number.isFinite(parsedStopLossPremium) &&
    parsedStopLossPremium > 0
      ? roundMoney(parsedEntryPremium - parsedStopLossPremium)
      : null;
  const previousRiskPoints = Number(previousMetrics.riskPoints);
  const riskPoints =
    calculatedRiskPoints !== null
      ? calculatedRiskPoints
      : Number.isFinite(previousRiskPoints) && previousRiskPoints > 0
        ? roundMoney(previousRiskPoints)
        : null;

  if (!Number.isFinite(parsedCurrentPremium) || parsedCurrentPremium <= 0) {
    return {
      ...previousMetrics,
      capitalDeployed,
      stopLossMoney,
      riskPoints,
    };
  }

  const runningProfitAmount =
    Number.isFinite(parsedQuantity) &&
    parsedQuantity > 0 &&
    Number.isFinite(parsedEntryPremium) &&
    parsedEntryPremium > 0
      ? roundMoney((parsedCurrentPremium - parsedEntryPremium) * parsedQuantity)
      : null;
  const runningProfitPercent =
    capitalDeployed && capitalDeployed > 0 && runningProfitAmount !== null
      ? roundPercent((runningProfitAmount / capitalDeployed) * 100)
      : null;
  const rewardPoints =
    Number.isFinite(parsedEntryPremium) && parsedEntryPremium > 0
      ? roundMoney(parsedCurrentPremium - parsedEntryPremium)
      : null;
  const riskRewardRatio =
    riskPoints && riskPoints > 0 && rewardPoints !== null
      ? roundPercent(rewardPoints / riskPoints)
      : null;
  const riskReward =
    riskRewardRatio !== null
      ? `1:${riskRewardRatio.toFixed(2).replace(/\.?0+$/, "")}`
      : null;

  return {
    ...previousMetrics,
    capitalDeployed,
    stopLossMoney,
    riskPoints,
    currentPremium: roundMoney(parsedCurrentPremium),
    currentPremiumCheckedAt: nowIso(),
    runningProfitAmount,
    runningProfitPercent,
    rewardPoints,
    riskRewardRatio,
    riskReward,
  };
}

function applyTradeMetrics(trade, metrics) {
  const fieldNames = [
    "capitalDeployed",
    "stopLossMoney",
    "currentPremium",
    "currentPremiumCheckedAt",
    "runningProfitAmount",
    "runningProfitPercent",
    "rewardPoints",
    "riskRewardRatio",
    "riskReward",
  ];

  fieldNames.forEach((fieldName) => {
    if (metrics[fieldName] !== undefined) {
      trade[fieldName] = metrics[fieldName];
    }
  });

  if (metrics.riskPoints !== null && metrics.riskPoints !== undefined) {
    trade.riskPoints = metrics.riskPoints;
  }
}

function createTrade(entry) {
  const history = getTradeHistoryForToday();
  const sequence = history.trades.length + 1;
  const tradeMode = normalizeTradeMode(entry.tradeMode);
  const entryPrice = entry.entryPrice || entry.entryPremiumReference || null;
  const trade = {
    id: `${history.date}-${sequence}-${Date.now()}`,
    sequence,
    tradeMode,
    status: entry.stopLossOrderId ? "RUNNING" : "RUNNING_UNPROTECTED",
    entrySignal: entry.signal,
    entryTime: nowIso(),
    entryOrderId: entry.entryOrderId || null,
    securityId: entry.securityId,
    quantity: entry.quantity,
    optionSymbol: entry.optionSymbol,
    stopLossOrderId: entry.stopLossOrderId || null,
    premiumStopLoss: entry.premiumStopLoss || null,
    premiumStopLossCandle: entry.premiumStopLossCandle || null,
    premiumSlInterval: entry.premiumSlInterval || null,
    entryPremiumReference: entry.entryPremiumReference || null,
    entryPrice,
    riskPoints: entry.riskPoints || null,
    riskSource: entry.riskSource || null,
    exitSignal: null,
    exitTime: null,
    exitOrderId: null,
  };
  applyTradeMetrics(
    trade,
    calculateTradeMetrics({
      quantity: trade.quantity,
      entryPremium: entryPrice,
      stopLossPremium: trade.premiumStopLoss,
      previousMetrics: {
        riskPoints: trade.riskPoints,
      },
    }),
  );

  history.trades.push(trade);
  saveTradeHistory(history);
  return trade;
}

function findLatestOpenTrade(trades) {
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    if (["RUNNING", "RUNNING_UNPROTECTED"].includes(trades[index].status)) {
      return trades[index];
    }
  }

  return null;
}

function markLatestOpenTradeExited({ signal, exitOrderId, manual = false, tradeMode }) {
  const history = getTradeHistoryForToday();
  const normalizedMode = tradeMode ? normalizeTradeMode(tradeMode) : null;
  const trade = findLatestOpenTrade(
    normalizedMode
      ? history.trades.filter((item) => item.tradeMode === normalizedMode)
      : history.trades,
  );

  if (!trade) {
    return null;
  }

  trade.status = manual ? "MANUAL_EXIT" : "EXITED";
  trade.exitSignal = signal;
  trade.exitTime = nowIso();
  trade.exitOrderId = exitOrderId || null;

  saveTradeHistory(history);
  return trade;
}

function markTradeStopLossHit(stopLossOrderId) {
  const history = getTradeHistoryForToday();
  const trade = history.trades.find(
    (item) => item.stopLossOrderId && item.stopLossOrderId === stopLossOrderId,
  );

  if (!trade || trade.status === "SL_HIT") {
    return trade || null;
  }

  trade.status = "SL_HIT";
  trade.exitSignal = "PREMIUM_SL";
  trade.exitTime = nowIso();
  trade.exitOrderId = stopLossOrderId;

  saveTradeHistory(history);
  return trade;
}

function markTradeFailed(entryOrderId, failureReason) {
  const history = getTradeHistoryForToday();
  const trade = history.trades.find(
    (item) => item.entryOrderId && item.entryOrderId === entryOrderId,
  );

  if (!trade) {
    return null;
  }

  trade.status = "FAILED";
  trade.failureReason = failureReason || "Entry order failed";
  trade.exitTime = nowIso();
  saveTradeHistory(history);
  return trade;
}

function updateLatestOpenTradeMarket({
  securityId,
  tradeMode,
  currentPremium,
}) {
  const history = getTradeHistoryForToday();
  const normalizedMode = tradeMode ? normalizeTradeMode(tradeMode) : null;
  const trade = findLatestOpenTrade(
    history.trades.filter((item) => {
      if (normalizedMode && item.tradeMode !== normalizedMode) {
        return false;
      }

      return securityId ? String(item.securityId) === String(securityId) : true;
    }),
  );

  if (!trade) {
    return null;
  }

  applyTradeMetrics(
    trade,
    calculateTradeMetrics({
      quantity: trade.quantity,
      entryPremium: getTradeEntryPremium(trade),
      stopLossPremium: trade.premiumStopLoss,
      currentPremium,
      previousMetrics: {
        capitalDeployed: trade.capitalDeployed,
        stopLossMoney: trade.stopLossMoney,
        riskPoints: trade.riskPoints,
      },
    }),
  );

  saveTradeHistory(history);
  return trade;
}

function updateLatestOpenTradeStopLoss({ securityId, tradeMode, premiumStopLoss }) {
  const history = getTradeHistoryForToday();
  const normalizedMode = tradeMode ? normalizeTradeMode(tradeMode) : null;
  const trade = findLatestOpenTrade(
    history.trades.filter((item) => {
      if (normalizedMode && item.tradeMode !== normalizedMode) {
        return false;
      }

      return securityId ? String(item.securityId) === String(securityId) : true;
    }),
  );

  if (!trade) {
    return null;
  }

  trade.premiumStopLoss = premiumStopLoss || null;
  applyTradeMetrics(
    trade,
    calculateTradeMetrics({
      quantity: trade.quantity,
      entryPremium: getTradeEntryPremium(trade),
      stopLossPremium: premiumStopLoss,
      currentPremium: trade.currentPremium,
      previousMetrics: {
        capitalDeployed: trade.capitalDeployed,
        stopLossMoney: trade.stopLossMoney,
        riskPoints: trade.riskPoints,
      },
    }),
  );

  saveTradeHistory(history);
  return trade;
}

function getDashboardTrades(limit = 3, tradeMode, fallbackPremiumSlInterval) {
  const history = getTradeHistoryForToday();
  const normalizedMode = tradeMode ? normalizeTradeMode(tradeMode) : null;
  const trades = normalizedMode
    ? history.trades.filter((trade) => trade.tradeMode === normalizedMode)
    : history.trades;

  return trades.slice(-limit).map((trade) => {
    const riskPoints = Number(trade.riskPoints);
    const quantity = Number(trade.quantity);
    const riskAmount =
      Number.isFinite(riskPoints) &&
      riskPoints > 0 &&
      Number.isFinite(quantity) &&
      quantity > 0
        ? Number((riskPoints * quantity).toFixed(2))
        : null;

    return {
      id: trade.id,
      sequence: trade.sequence,
      tradeMode: trade.tradeMode,
      label: getOrdinalLabel(trade.sequence),
      status: trade.status,
      displayStatus: getDisplayStatus(trade.status),
      entrySignal: trade.entrySignal,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      optionSymbol: trade.optionSymbol,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice || trade.entryPremiumReference || null,
      exitPrice: trade.exitPrice || null,
      realizedProfit: trade.realizedProfit || null,
      riskPoints: trade.riskPoints,
      riskAmount,
      capitalDeployed: trade.capitalDeployed || null,
      stopLossMoney: trade.stopLossMoney || null,
      currentPremium: trade.currentPremium || null,
      currentPremiumCheckedAt: trade.currentPremiumCheckedAt || null,
      runningProfitAmount: trade.runningProfitAmount || null,
      runningProfitPercent:
        trade.runningProfitPercent === 0 ? 0 : trade.runningProfitPercent || null,
      rewardPoints: trade.rewardPoints === 0 ? 0 : trade.rewardPoints || null,
      riskRewardRatio:
        trade.riskRewardRatio === 0 ? 0 : trade.riskRewardRatio || null,
      riskReward: trade.riskReward || null,
      premiumSlActive:
        ["RUNNING", "RUNNING_UNPROTECTED"].includes(trade.status) &&
        Boolean(trade.stopLossOrderId),
      premiumSlInterval:
        trade.premiumSlInterval ||
        (trade.premiumStopLoss ? fallbackPremiumSlInterval || null : null),
    };
  });
}

module.exports = {
  calculateTradeMetrics,
  createTrade,
  getDashboardTrades,
  getDisplayStatus,
  markLatestOpenTradeExited,
  markTradeFailed,
  markTradeStopLossHit,
  updateLatestOpenTradeMarket,
  updateLatestOpenTradeStopLoss,
};
