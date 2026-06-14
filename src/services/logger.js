/*
 * Central Winston logger for the bot.
 * Logs are written to logs/app.log for dashboard display.
 * The same messages also go to console for terminal debugging.
 */
const winston = require("winston");

// Timestamp each message and keep the text compact for dashboard readability.
const logger = winston.createLogger({
  level: "info",

  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `${timestamp} [${level.toUpperCase()}] ${message}`,
    ),
  ),

  // File logs feed the control panel; console logs help while running locally.
  transports: [
    new winston.transports.File({
      filename: "logs/app.log",
    }),

    new winston.transports.Console(),
  ],
});

module.exports = logger;
