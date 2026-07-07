/*
 * Calculates suggested lot size from capital, risk percent, stop-loss points,
 * lot size, daily trade limits, and directional market bias.
 * The dashboard and live entry path use this same calculation.
 * Returned values include the intermediate math for dashboard display/debugging.
 */
const { getUnderlyingProfile } = require("./underlyingService");

function getLocalDateKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(date);
}

function isExpiryToday(expiryDate) {
  const dateKey = String(expiryDate || "").slice(0, 10);

  return /^\d{4}-\d{2}-\d{2}$/.test(dateKey) && dateKey === getLocalDateKey();
}

function calculateLots({ signal, riskPoints, settings = process.env }) {
  const underlyingProfile = getUnderlyingProfile(settings);

  // Pull numeric risk settings from environment with conservative defaults.
  const capital = Number(settings.TRADING_CAPITAL || 0);
  const riskPercent = Number(settings.RISK_PERCENT || 1);
  const expiryRiskReductionActive = isExpiryToday(settings.CONTRACT_EXPIRY_DATE);
  const effectiveRiskPercent = expiryRiskReductionActive
    ? riskPercent / 2
    : riskPercent;
  const lotSize = Number(settings.LOT_SIZE || underlyingProfile.lotSize);
  const maxTrades = Number(settings.MAX_DAILY_TRADES || 1);

  const riskMode = settings.RISK_MODE || "PER_TRADE";
  const marketBias = settings.MARKET_BIAS || "NEUTRAL";

  const riskAmount = (capital * effectiveRiskPercent) / 100;
  const lossPerLot = Number(riskPoints || 0) * lotSize;

  let lots = 0;

  // Convert rupee risk into lots; PER_DAY spreads risk across max daily trades.
  if (lossPerLot > 0) {
    lots = Math.floor(riskAmount / lossPerLot);

    if (riskMode === "PER_DAY") {
      lots = Math.floor(lots / maxTrades);
    }
  }

  let finalLots = lots;

  // Reduce counter-bias trades, but keep at least one lot when possible.
  if (marketBias === "BULLISH" && signal === "SHORT_ENTRY") {
    finalLots = lots > 1 ? Math.max(1, Math.floor(lots / 2)) : lots;
  }

  if (marketBias === "BEARISH" && signal === "LONG_ENTRY") {
    finalLots = lots > 1 ? Math.max(1, Math.floor(lots / 2)) : lots;
  }

  const quantity = finalLots * lotSize;

  // Return both the decision and supporting numbers for transparency.
  return {
    capital,
    riskPercent,
    effectiveRiskPercent,
    expiryRiskReductionActive,
    riskMode,
    marketBias,
    riskPoints,
    riskAmount,
    lossPerLot,
    lots,
    finalLots,
    lotSize,
    quantity,
  };
}

module.exports = {
  calculateLots,
};
