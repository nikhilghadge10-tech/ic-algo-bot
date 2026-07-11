/*
 * Sends operational alerts to Telegram.
 * The webhook uses this for entries, exits, ignored signals, and failures.
 * Errors are logged without failing the trading flow.
 */
const axios = require("axios");
const logger = require("./logger");
const { getRuntimeEnv } = require("./dhanRuntimeConfig");

const DEFAULT_DEDUPE_WINDOW_MS = 60 * 1000;
const DEFAULT_MIN_SEND_INTERVAL_MS = 1100;
const recentMessages = new Map();
let sendQueue = Promise.resolve();
let lastSendStartedAt = 0;

function getPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shouldSuppressDuplicate(message, now = Date.now()) {
  const env = getRuntimeEnv();
  const windowMs = getPositiveNumber(
    env.TELEGRAM_DEDUPE_WINDOW_MS,
    DEFAULT_DEDUPE_WINDOW_MS,
  );
  const key = String(message);
  const previous = recentMessages.get(key);

  // Record at queue time so concurrent copies cannot all pass the check.
  recentMessages.set(key, now);
  for (const [storedMessage, storedAt] of recentMessages) {
    if (now - storedAt > windowMs) recentMessages.delete(storedMessage);
  }

  return windowMs > 0 && previous !== undefined && now - previous < windowMs;
}

async function waitForSendSlot() {
  const env = getRuntimeEnv();
  const intervalMs = getPositiveNumber(
    env.TELEGRAM_MIN_SEND_INTERVAL_MS,
    DEFAULT_MIN_SEND_INTERVAL_MS,
  );
  const remaining = intervalMs - (Date.now() - lastSendStartedAt);
  if (remaining > 0) await delay(remaining);
  lastSendStartedAt = Date.now();
}

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

  if (shouldSuppressDuplicate(message)) {
    logger.info("Telegram duplicate suppressed");
    return Promise.resolve({
      success: true,
      skipped: true,
      duplicate: true,
    });
  }

  // Serialize sends and leave a small gap to avoid Telegram rate-limit bursts.
  sendQueue = sendQueue
    .catch(() => undefined)
    .then(async () => {
      await waitForSendSlot();
      return sendTelegramAndWait(message);
    });

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
