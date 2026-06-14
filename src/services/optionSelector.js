/*
 * Converts TradingView signals into option-selection inputs.
 * LONG_ENTRY maps to a NIFTY call option and SHORT_ENTRY maps to a put option.
 * Strike selection currently uses the nearest 50-point ATM strike.
 */
function getATMStrike(price) {
  // NIFTY option strikes are selected in 50-point steps.
  return Math.round(price / 50) * 50;
}

// Return the strike and CE/PE type needed by instrumentService.
function getOptionDetails(signal, price) {
  const strike = getATMStrike(Number(price));

  return {
    strike,
    optionType:
      signal === "LONG_ENTRY" ? "CE" : signal === "SHORT_ENTRY" ? "PE" : null,
  };
}

module.exports = {
  getATMStrike,
  getOptionDetails,
};
