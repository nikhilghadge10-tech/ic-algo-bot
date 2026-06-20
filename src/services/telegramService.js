/*
 * Sends operational alerts to Telegram.
 * The webhook uses this for entries, exits, ignored signals, and failures.
 * Errors are logged without failing the trading flow.
 */
const axios = require("axios");
const logger = require("./logger");
const { getRuntimeEnv } = require("./dhanRuntimeConfig");

function isTelegramEnabled() {
  const env = getRuntimeEnv();
  return String(env.TELEGRAM_ENABLED).toLowerCase() === "true";
}

// Post a plain text message to the configured Telegram chat.
async function sendTelegramAndWait(message) {
  if (!isTelegramEnabled()) {
    return {
      success: true,
      disabled: true,
      skipped: true,
    };
  }

  const env = getRuntimeEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    logger.error("Telegram Error: enabled but credentials are missing");
    return {
      success: false,
      error: "Telegram credentials are missing",
    };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Telegram failures matter, but should not block order/position processing.
  try {
    const response = await axios.post(url, {
      chat_id: chatId,
      text: message,
    }, {
      timeout: 5000,
    });

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    logger.error(
      `Telegram Error: ${JSON.stringify(
        error.response?.data || error.message,
      )}`,
    );

    return {
      success: false,
      error: error.response?.data || error.message,
    };
  }
}

// Queue notifications without delaying TradingView webhook responses.
function sendTelegram(message) {
  if (!isTelegramEnabled()) {
    return Promise.resolve({
      success: true,
      disabled: true,
      skipped: true,
    });
  }

  void sendTelegramAndWait(message);

  return Promise.resolve({
    success: true,
    queued: true,
  });
}

module.exports = {
  isTelegramEnabled,
  sendTelegram,
  sendTelegramAndWait,
};
