function calculateLots({ signal, riskPoints }) {
  const capital = Number(process.env.TRADING_CAPITAL || 0);
  const riskPercent = Number(process.env.RISK_PERCENT || 1);
  const lotSize = Number(process.env.LOT_SIZE || 65);
  const maxTrades = Number(process.env.MAX_DAILY_TRADES || 1);

  const riskMode = process.env.RISK_MODE || "PER_TRADE";
  const marketBias = process.env.MARKET_BIAS || "NEUTRAL";

  const riskAmount = (capital * riskPercent) / 100;
  const lossPerLot = Number(riskPoints || 0) * lotSize;

  let lots = 0;

  if (lossPerLot > 0) {
    lots = Math.floor(riskAmount / lossPerLot);

    if (riskMode === "PER_DAY") {
      lots = Math.floor(lots / maxTrades);
    }
  }

  let finalLots = lots;

  if (marketBias === "BULLISH" && signal === "SHORT_ENTRY") {
    finalLots = lots > 1 ? Math.max(1, Math.floor(lots / 2)) : lots;
  }

  if (marketBias === "BEARISH" && signal === "LONG_ENTRY") {
    finalLots = lots > 1 ? Math.max(1, Math.floor(lots / 2)) : lots;
  }

  const quantity = finalLots * lotSize;

  return {
    capital,
    riskPercent,
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
