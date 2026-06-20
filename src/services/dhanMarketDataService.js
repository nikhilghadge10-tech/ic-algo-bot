/*
 * Fetches Dhan market data for spot and selected option contracts.
 * The premium stop-loss feature uses this to read the previous completed
 * option-premium candle before placing an entry order.
 * The manual signal panel uses LTP quotes to pre-fill current NIFTY spot.
 */
const axios = require("axios");
const {
  getDhanHeaders,
  getDhanUrl,
  getRuntimeEnv,
  requireDhanMarketDataConfig,
} = require("./dhanRuntimeConfig");

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
  const env = getRuntimeEnv();
  const exchangeSegment = env.NIFTY_SPOT_SEGMENT || "IDX_I";
  const securityId = String(env.NIFTY_SPOT_SECURITY_ID || "13");
  const result = await getInstrumentLtp(exchangeSegment, securityId);

  return {
    symbol: "NIFTY",
    ...result,
  };
}

async function getInstrumentLtp(exchangeSegment, securityId, instrument) {
  const config = requireDhanMarketDataConfig();
  const normalizedSecurityId = String(securityId);

  const payload = {
    [exchangeSegment]: [Number(normalizedSecurityId)],
  };

  const response = await axios.post(
    getDhanUrl("/v2/marketfeed/ltp", config),
    payload,
    {
      headers: {
        ...getDhanHeaders(config),
      },
    },
  );

  const ltp = Number(
    extractLtp(response.data, exchangeSegment, normalizedSecurityId),
  );

  if (!Number.isFinite(ltp) || ltp <= 0) {
    throw new Error(
      `LTP missing in Dhan response for ${exchangeSegment}:${normalizedSecurityId}`,
    );
  }

  return {
    ltp,
    exchangeSegment,
    securityId: normalizedSecurityId,
    checkedAt: new Date().toISOString(),
    response: response.data,
  };
}

async function getOptionLtp(contract) {
  return getInstrumentLtp(
    "NSE_FNO",
    String(contract.SEM_SMST_SECURITY_ID),
    contract.SEM_INSTRUMENT_NAME || "OPTIDX",
  );
}

async function getPreviousCompletedIntradayCandle(
  contract,
  intervalMinutes,
  referenceTime,
) {
  const env = getRuntimeEnv();
  const config = requireDhanMarketDataConfig();
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
    getDhanUrl("/v2/charts/intraday", config),
    payload,
    {
      headers: {
        ...getDhanHeaders(config),
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
  getOptionLtp,
  getNiftySpotLtp,
  getPreviousCompletedIntradayCandle,
};
