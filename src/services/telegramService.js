/*
 * Sends operational alerts to Telegram.
 * The webhook uses this for entries, exits, ignored signals, and failures.
 * Errors are logged and re-thrown so callers know notification failed.
 */
const axios = require("axios");
const logger = require("./logger");

// Post a plain text message to the configured Telegram chat.
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Telegram failures are important because they hide trading state changes.
  try {
    const response = await axios.post(url, {
      chat_id: chatId,
      text: message,
    });

    logger.info("Telegram sent successfully");

    return response.data;
  } catch (error) {
    logger.error(
      `Telegram Error: ${JSON.stringify(
        error.response?.data || error.message,
      )}`,
    );

    throw error;
  }
}

module.exports = {
  sendTelegram,
};
