const axios = require("axios");
const logger = require("./logger");

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

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
