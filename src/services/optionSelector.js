/*
 * Converts TradingView signals into option-selection inputs.
 * LONG_ENTRY maps to a call option and SHORT_ENTRY maps to a put option.
 * Strike selection uses the active underlying profile's strike step.
 */
function getATMStrike(price, strikeStep = 50) {
  const step = Number(strikeStep) || 50;

  return Math.round(Number(price) / step) * step;
}

// Return the strike and CE/PE type needed by instrumentService.
function getOptionDetails(signal, price, profile = {}) {
  const strike = getATMStrike(Number(price), profile.strikeStep);

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
