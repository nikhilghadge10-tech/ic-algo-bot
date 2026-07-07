/*
 * Resets day-scoped dashboard controls once per IST date.
 * This clears yesterday's emergency stop without rewriting credentials or sizing plans.
 */
const fs = require("fs");
const dotenv = require("dotenv");
const { getIstDateKey } = require("./tradeLimitService");

const RESET_DATE_KEY = "CONTROL_PANEL_RESET_DATE";

const DAILY_CONTROL_DEFAULTS = {
  NO_TRADE_TODAY: "false",
  ALLOW_BUY: "true",
  ALLOW_SELL: "true",
  ALLOW_NIFTY_TV_SIGNALS: "true",
  ALLOW_BANKNIFTY_TV_SIGNALS: "true",
  PAPER_TRADE: "false",
  AUTO_PREMIUM_SL: "true",
  AUTO_TRAIL_SL: "true",
  MARKET_BIAS: "NEUTRAL",
};

function readEnvText(envPath) {
  return fs.readFileSync(envPath, "utf8");
}

function parseEnvText(content) {
  return dotenv.parse(Buffer.from(content));
}

function writeEnvUpdates(envPath, updates) {
  const lines = readEnvText(envPath).split("\n");
  const updatedKeys = new Set();

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    const [key] = trimmed.split("=");

    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      updatedKeys.add(key);
      return key + "=" + updates[key];
    }

    return line;
  });

  Object.entries(updates).forEach(([key, value]) => {
    if (!updatedKeys.has(key)) {
      updatedLines.push(key + "=" + value);
    }
  });

  fs.writeFileSync(envPath, updatedLines.join("\n"));
}

function applyDailyControlReset(envPath, options = {}) {
  const today = getIstDateKey();
  const content = readEnvText(envPath);
  const env = parseEnvText(content);

  if (env[RESET_DATE_KEY] === today) {
    return {
      applied: false,
      date: today,
    };
  }

  if (!env[RESET_DATE_KEY]) {
    writeEnvUpdates(envPath, { [RESET_DATE_KEY]: today });

    if (options.logger?.info) {
      options.logger.info(
        "Daily control reset baseline set for " + today,
      );
    }

    return {
      applied: false,
      date: today,
      baselineCreated: true,
    };
  }

  const updates = {
    ...DAILY_CONTROL_DEFAULTS,
    [RESET_DATE_KEY]: today,
  };

  writeEnvUpdates(envPath, updates);

  if (options.logger?.info) {
    options.logger.info(
      "Daily control reset applied: " +
        Object.entries(updates)
          .map(([key, value]) => key + "=" + value)
          .join(" "),
    );
  }

  return {
    applied: true,
    date: today,
    updates,
  };
}

module.exports = {
  DAILY_CONTROL_DEFAULTS,
  RESET_DATE_KEY,
  applyDailyControlReset,
};
