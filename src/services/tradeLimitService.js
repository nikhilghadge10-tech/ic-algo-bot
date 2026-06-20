/*
 * Tracks daily successful entry count for safety enforcement.
 * The count is stored on disk so restarting the algo server does not reset it.
 * Trading day is based on IST because the bot is intended for Indian markets.
 * Only successful LONG_ENTRY/SHORT_ENTRY orders should increment this counter.
 */
const fs = require("fs");
const path = require("path");

const tradeStateFile = path.join(__dirname, "../data/tradeState.json");

// Convert the current time to an IST calendar date key like 2026-06-14.
function getIstDateKey(date = new Date()) {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  return new Date(date.getTime() + istOffsetMs).toISOString().slice(0, 10);
}

// Load saved trade count, defaulting to zero for today if missing/corrupt.
function loadTradeState() {
  try {
    const data = fs.readFileSync(tradeStateFile, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return {
      date: getIstDateKey(),
      entryCount: 0,
    };
  }
}

// Persist the trade counter snapshot.
function saveTradeState(state) {
  fs.writeFileSync(tradeStateFile, JSON.stringify(state, null, 2));
}

// Reset the counter automatically when the IST date changes.
function getTradeStateForToday() {
  const today = getIstDateKey();
  const state = loadTradeState();

  if (state.date !== today) {
    const resetState = {
      date: today,
      entryCount: 0,
    };

    saveTradeState(resetState);
    return resetState;
  }

  return {
    date: today,
    entryCount: Number(state.entryCount || 0),
    countsByMode: {
      PAPER: Number(state.countsByMode?.PAPER || 0),
      SANDBOX: Number(state.countsByMode?.SANDBOX || 0),
      LIVE: Number(state.countsByMode?.LIVE || 0),
    },
  };
}

function normalizeTradeMode(mode) {
  const normalized = String(mode || "").toUpperCase();

  return ["LIVE", "SANDBOX"].includes(normalized) ? normalized : "PAPER";
}

// Check whether another entry is allowed under the configured daily max.
function getDailyTradeLimitStatus(maxDailyTrades, mode) {
  const limit = Number(maxDailyTrades || 0);
  const state = getTradeStateForToday();
  const tradeMode = normalizeTradeMode(mode);
  const entryCount = mode
    ? Number(state.countsByMode?.[tradeMode] || 0)
    : Number(state.entryCount || 0);

  return {
    ...state,
    mode: tradeMode,
    entryCount,
    limit,
    remaining: Math.max(limit - entryCount, 0),
    allowed: limit <= 0 || entryCount < limit,
  };
}

// Increment after a successful entry order and return the updated state.
function recordSuccessfulEntry(mode) {
  const state = getTradeStateForToday();
  const tradeMode = normalizeTradeMode(mode);
  const countsByMode = {
    PAPER: Number(state.countsByMode?.PAPER || 0),
    SANDBOX: Number(state.countsByMode?.SANDBOX || 0),
    LIVE: Number(state.countsByMode?.LIVE || 0),
  };

  countsByMode[tradeMode] += 1;

  const updatedState = {
    date: state.date,
    entryCount:
      countsByMode.PAPER + countsByMode.SANDBOX + countsByMode.LIVE,
    countsByMode,
  };

  saveTradeState(updatedState);
  return getDailyTradeLimitStatus(0, tradeMode);
}

function rollbackSuccessfulEntry(mode) {
  const state = getTradeStateForToday();
  const tradeMode = normalizeTradeMode(mode);
  const countsByMode = {
    PAPER: Number(state.countsByMode?.PAPER || 0),
    SANDBOX: Number(state.countsByMode?.SANDBOX || 0),
    LIVE: Number(state.countsByMode?.LIVE || 0),
  };

  countsByMode[tradeMode] = Math.max(countsByMode[tradeMode] - 1, 0);

  const updatedState = {
    date: state.date,
    entryCount:
      countsByMode.PAPER + countsByMode.SANDBOX + countsByMode.LIVE,
    countsByMode,
  };

  saveTradeState(updatedState);
  return getDailyTradeLimitStatus(0, tradeMode);
}

module.exports = {
  getDailyTradeLimitStatus,
  getIstDateKey,
  normalizeTradeMode,
  recordSuccessfulEntry,
  rollbackSuccessfulEntry,
};
