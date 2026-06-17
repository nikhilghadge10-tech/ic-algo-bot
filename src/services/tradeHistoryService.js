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

function createTrade(entry) {
  const history = getTradeHistoryForToday();
  const sequence = history.trades.length + 1;
  const tradeMode = normalizeTradeMode(entry.tradeMode);
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
    exitSignal: null,
    exitTime: null,
    exitOrderId: null,
  };

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

function getDashboardTrades(limit = 3, tradeMode) {
  const history = getTradeHistoryForToday();
  const normalizedMode = tradeMode ? normalizeTradeMode(tradeMode) : null;
  const trades = normalizedMode
    ? history.trades.filter((trade) => trade.tradeMode === normalizedMode)
    : history.trades;

  return trades.slice(-limit).map((trade) => ({
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
  }));
}

module.exports = {
  createTrade,
  getDashboardTrades,
  getDisplayStatus,
  markLatestOpenTradeExited,
  markTradeStopLossHit,
};
