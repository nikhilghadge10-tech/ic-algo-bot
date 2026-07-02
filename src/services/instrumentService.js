/*
 * Loads the Dhan instrument master CSV into memory.
 * The webhook uses this cache to find a matching index option contract.
 * Contract lookup is based on strike and CE/PE option type.
 * The nearest expiry is selected from the matching contracts.
 */
const fs = require("fs");
const csv = require("csv-parser");

let instruments = [];

// Read the large instrument CSV once at startup and keep it in memory.
function loadInstruments() {
  return new Promise((resolve, reject) => {
    const results = [];

    fs.createReadStream("api-scrip-master.csv")
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => {
        instruments = results;

        console.log(`Loaded ${instruments.length} instruments`);

        resolve();
      })
      .on("error", reject);
  });
}

// Finds the nearest-expiry option matching the requested underlying, strike, and type.
function getIndexOption(strike, optionType, profile = {}) {
  const today = new Date();
  const marketCloseToday = new Date(today);
  const optionSymbolPrefix = profile.optionSymbolPrefix || "NIFTY ";

  marketCloseToday.setHours(15, 30, 0, 0);

  // Filter down to the selected index options for the exact strike and CE/PE direction.
  const matches = instruments.filter((row) => {
    const expiry = new Date(row.SEM_EXPIRY_DATE);
    const expiryMarketClose = new Date(expiry);

    // Dhan's master stores expiry around 14:30 UTC/20:00 IST for some rows,
    // so compare calendar dates and keep today's expiry only until market close.
    expiryMarketClose.setHours(15, 30, 0, 0);

    const isTradableExpiry =
      Number.isFinite(expiry.getTime()) &&
      (expiryMarketClose.toDateString() !== today.toDateString()
        ? expiryMarketClose > today
        : today <= marketCloseToday);

    return (
      row.SEM_CUSTOM_SYMBOL?.startsWith(optionSymbolPrefix) &&
      row.SEM_OPTION_TYPE === optionType &&
      Number(row.SEM_STRIKE_PRICE) === strike &&
      isTradableExpiry
    );
  });

  if (!matches.length) {
    return null;
  }

  // Sort by expiry so the first item is the nearest available contract.
  matches.sort((a, b) => {
    const d1 = new Date(a.SEM_EXPIRY_DATE);
    const d2 = new Date(b.SEM_EXPIRY_DATE);

    return d1 - d2;
  });

  return matches[0];
}

function getNiftyOption(strike, optionType) {
  return getIndexOption(strike, optionType, {
    optionSymbolPrefix: "NIFTY ",
  });
}

module.exports = {
  loadInstruments,
  getIndexOption,
  getNiftyOption,
};
