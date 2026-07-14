/*
 * Fetches Dhan's official historical trade charges. Unlike the intraday trade
 * book, this statement endpoint includes brokerage and statutory charges.
 */
const axios = require("axios");
const {
  getDhanHeaders,
  getDhanUrl,
  requireDhanRuntimeConfig,
} = require("./dhanRuntimeConfig");

async function getTradeChargesForDate(date) {
  const config = requireDhanRuntimeConfig();
  const response = await axios.get(
    getDhanUrl(`/v2/trades/${date}/${date}/0`, config),
    { headers: getDhanHeaders(config), timeout: 10000 },
  );
  const rows = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.data?.data)
      ? response.data.data
      : [];

  return { environment: config.environment, rows };
}

module.exports = { getTradeChargesForDate };
