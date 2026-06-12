const fs = require("fs");
const csv = require("csv-parser");

let instruments = [];

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

function getNiftyOption(strike, optionType) {
  const today = new Date();

  const matches = instruments.filter((row) => {
    return (
      row.SEM_CUSTOM_SYMBOL?.startsWith("NIFTY ") &&
      row.SEM_OPTION_TYPE === optionType &&
      Number(row.SEM_STRIKE_PRICE) === strike
    );
  });

  if (!matches.length) {
    return null;
  }

  matches.sort((a, b) => {
    const d1 = new Date(a.SEM_EXPIRY_DATE);
    const d2 = new Date(b.SEM_EXPIRY_DATE);

    return d1 - d2;
  });

  return matches[0];
}

module.exports = {
  loadInstruments,
  getNiftyOption,
};
