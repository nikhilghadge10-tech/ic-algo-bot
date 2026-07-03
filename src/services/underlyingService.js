const UNDERLYING_PROFILES = {
  NIFTY: {
    symbol: "NIFTY",
    aliases: ["NIFTY", "NIFTY50"],
    displayName: "NIFTY",
    optionSymbolPrefix: "NIFTY ",
    strikeStep: 50,
    lotSize: 65,
    spotSegment: "IDX_I",
    spotSecurityId: "13",
    planningSlPoints: 25,
  },
  BANKNIFTY: {
    symbol: "BANKNIFTY",
    aliases: [
      "BANKNIFTY",
      "BANKNIFTY1!",
      "BANKNIFTYSPOT",
      "BANKNIFTY50",
      "NIFTYBANK",
      "CNXBANK",
    ],
    displayName: "BANKNIFTY",
    optionSymbolPrefix: "BANKNIFTY ",
    strikeStep: 100,
    lotSize: 30,
    spotSegment: "IDX_I",
    spotSecurityId: "25",
    planningSlPoints: 40,
  },
};

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .toUpperCase()
    .replace(/^.*:/, "")
    .replace(/[^A-Z0-9]/g, "");
}

function getUnderlyingProfile(config = {}) {
  const requested = normalizeSymbol(
    config.UNDERLYING_SYMBOL || config.OPTION_UNDERLYING || "NIFTY",
  );
  const base =
    UNDERLYING_PROFILES[requested] || UNDERLYING_PROFILES.NIFTY;

  return {
    ...base,
    lotSize: Number(config.LOT_SIZE || base.lotSize),
    strikeStep: Number(config.STRIKE_STEP || base.strikeStep),
    spotSegment:
      config.UNDERLYING_SPOT_SEGMENT ||
      config[`${base.symbol}_SPOT_SEGMENT`] ||
      base.spotSegment,
    spotSecurityId: String(
      config.UNDERLYING_SPOT_SECURITY_ID ||
        config[`${base.symbol}_SPOT_SECURITY_ID`] ||
        base.spotSecurityId,
    ),
    planningSlPoints: Number(
      config.PLANNING_SL_POINTS || base.planningSlPoints,
    ),
  };
}

function getUnderlyingProfileForSymbol(symbol, config = {}) {
  const normalized = normalizeSymbol(symbol);

  for (const profile of Object.values(UNDERLYING_PROFILES)) {
    if (profile.aliases.map(normalizeSymbol).includes(normalized)) {
      return getUnderlyingProfile({
        ...config,
        UNDERLYING_SYMBOL: profile.symbol,
      });
    }
  }

  return null;
}

function isAllowedUnderlyingSymbol(symbol, config = {}) {
  const profile = getUnderlyingProfile(config);
  const normalized = normalizeSymbol(symbol);

  return profile.aliases.map(normalizeSymbol).includes(normalized);
}

module.exports = {
  UNDERLYING_PROFILES,
  getUnderlyingProfile,
  getUnderlyingProfileForSymbol,
  isAllowedUnderlyingSymbol,
  normalizeSymbol,
};
