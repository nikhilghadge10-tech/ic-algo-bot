/*
 * Sends operational alerts to Telegram.
 * The webhook uses this for entries, exits, ignored signals, and failures.
 * Errors are logged without failing the trading flow.
 */
const axios = require("axios");
const logger = require("./logger");

// Post a plain text message to the configured Telegram chat.
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

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

module.exports = {
  sendTelegram,
};
