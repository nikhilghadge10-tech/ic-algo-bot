function getATMStrike(price) {
  return Math.round(price / 50) * 50;
}

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
