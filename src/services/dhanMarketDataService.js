/*
 * Fetches Dhan market data for spot and selected option contracts.
 * The premium stop-loss feature uses this to read the previous completed
 * option-premium candle before placing an entry order.
 * The manual signal panel uses LTP quotes to pre-fill current NIFTY spot.
 */
const axios = require("axios");

function formatIstDateTime(date) {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffsetMs);

  return istDate.toISOString().slice(0, 19).replace("T", " ");
}

function normalizeReferenceTime(referenceTime) {
  const date = referenceTime ? new Date(referenceTime) : new Date();

  if (Number.isNaN(date.getTime())) {
    return new Date();
  }

  return date;
}

function getIntervalStart(date, intervalMinutes) {
  const intervalMs = intervalMinutes * 60 * 1000;
  return new Date(Math.floor(date.getTime() / intervalMs) * intervalMs);
}

function toCandles(data) {
  const timestamps = data.timestamp || [];

  return timestamps.map((timestamp, index) => ({
    timestamp,
    time: new Date(Number(timestamp) * 1000),
    open: Number(data.open?.[index]),
    high: Number(data.high?.[index]),
    low: Number(data.low?.[index]),
    close: Number(data.close?.[index]),
    volume: Number(data.volume?.[index] || 0),
  }));
}

function extractLtp(responseData, exchangeSegment, securityId) {
  return (
    responseData?.data?.[exchangeSegment]?.[securityId]?.last_price ||
    responseData?.data?.[exchangeSegment]?.[securityId]?.lastPrice ||
    responseData?.data?.[exchangeSegment]?.[securityId]?.ltp ||
    responseData?.data?.[securityId]?.last_price ||
    responseData?.data?.[securityId]?.lastPrice ||
    responseData?.data?.[securityId]?.ltp
  );
}

async function getNiftySpotLtp() {
  const exchangeSegment = process.env.NIFTY_SPOT_SEGMENT || "IDX_I";
  const securityId = String(process.env.NIFTY_SPOT_SECURITY_ID || "13");
  const payload = {
    [exchangeSegment]: [Number(securityId)],
  };

  const response = await axios.post(
    "https://api.dhan.co/v2/marketfeed/ltp",
    payload,
    {
      headers: {
        "access-token": process.env.DHAN_ACCESS_TOKEN,
        "client-id": process.env.DHAN_CLIENT_ID,
        "Content-Type": "application/json",
      },
    },
  );

  const ltp = Number(extractLtp(response.data, exchangeSegment, securityId));

  if (!Number.isFinite(ltp) || ltp <= 0) {
    throw new Error(`NIFTY spot LTP missing in Dhan response`);
  }

  return {
    symbol: "NIFTY",
    ltp,
    exchangeSegment,
    securityId,
    checkedAt: new Date().toISOString(),
    response: response.data,
  };
}

async function getPreviousCompletedIntradayCandle(
  contract,
  intervalMinutes,
  referenceTime,
) {
  const interval = String(intervalMinutes || 15);
  const referenceDate = normalizeReferenceTime(referenceTime);
  const currentIntervalStart = getIntervalStart(
    referenceDate,
    Number(interval),
  );
  const fromDate = new Date(referenceDate.getTime() - 3 * 24 * 60 * 60 * 1000);

  const payload = {
    securityId: String(contract.SEM_SMST_SECURITY_ID),
    exchangeSegment: "NSE_FNO",
    instrument: contract.SEM_INSTRUMENT_NAME || "OPTIDX",
    interval,
    oi: false,
    fromDate: formatIstDateTime(fromDate),
    toDate: formatIstDateTime(referenceDate),
  };

  const response = await axios.post(
    "https://api.dhan.co/v2/charts/intraday",
    payload,
    {
      headers: {
        "access-token": process.env.DHAN_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    },
  );

  const candles = toCandles(response.data)
    .filter((candle) => {
      return (
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        candle.time.getTime() < currentIntervalStart.getTime()
      );
    })
    .sort((a, b) => a.time - b.time);

  return {
    candle: candles[candles.length - 1] || null,
    payload,
  };
}

module.exports = {
  getNiftySpotLtp,
  getPreviousCompletedIntradayCandle,
};
