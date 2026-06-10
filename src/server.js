require("dotenv").config();

const logger = require("./services/logger");
const express = require("express");
const { sendTelegram } = require("./services/telegramService");
const { getProfile } = require("./services/dhanService");
const { loadPosition, savePosition } = require("./services/positionService");
const { getOptionDetails } = require("./services/optionSelector");

let currentPosition = loadPosition().currentPosition;

console.log(`Restored Position: ${currentPosition}`);

const app = express();
let lastSignal = "";
let lastSignalTime = 0;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Algo Bot Running");
});

app.get("/test", async (req, res) => {
  try {
    await sendTelegram("🚀 Algo Bot Telegram Test Successful");

    res.send("Telegram sent");
  } catch (error) {
    console.error(error);

    res.status(500).send("Telegram failed");
  }
});

app.get("/dhan-test", async (req, res) => {
  try {
    const profile = await getProfile();

    console.log(profile);

    res.json(profile);
  } catch (error) {
    console.error(error);

    res.status(500).send("Dhan connection failed");
  }
});

const PORT = process.env.PORT || 3000;

app.get("/status", (req, res) => {
  res.json({
    currentPosition,
    lastSignal,
    lastSignalTime,
    allowBuy: process.env.ALLOW_BUY,
    allowSell: process.env.ALLOW_SELL,
    paperTrade: process.env.PAPER_TRADE,
    lotSize: process.env.LOT_SIZE,
    optionMode: process.env.OPTION_MODE,
  });
});

function getSignalEmoji(signal) {
  switch (signal) {
    case "LONG_ENTRY":
      return "🚀";

    case "LONG_EXIT":
      return "✅";

    case "SHORT_ENTRY":
      return "🔻";

    case "SHORT_EXIT":
      return "☑️";

    default:
      return "ℹ️";
  }
}

app.post("/webhook", async (req, res) => {
  try {
    logger.info(`Webhook received: ${JSON.stringify(req.body)}`);

    const { signal, symbol, price, time } = req.body;

    lastSignal = signal;
    lastSignalTime = time || new Date().toISOString();

    logger.info(`Last Signal Updated: ${signal}`);

    if (!signal || !symbol || !price) {
      return res.status(400).send("Invalid payload");
    }

    // Trading disabled today
    if (process.env.NO_TRADE_TODAY === "true") {
      await sendTelegram(
        `⚠️ Trading Disabled Today

Signal : ${signal}

Symbol : ${symbol}

Price : ${price}

No order placed.`,
      );

      return res.status(200).send("Trading disabled");
    }

    const emoji = getSignalEmoji(signal);

    switch (signal) {
      case "LONG_ENTRY": {
        if (currentPosition !== null) {
          await sendTelegram(
            `⚠️ LONG_ENTRY ignored

Current Position : ${currentPosition}`,
          );

          return res.status(200).send("Position already open");
        }

        currentPosition = "LONG";
        logger.info("Position changed to LONG");

        savePosition({
          currentPosition,
        });

        const option = getOptionDetails(signal, price);

        logger.info(`Selected Option: ${option.strike} ${option.optionType}`);

        await sendTelegram(
          `${emoji} PAPER TRADE

Signal : LONG_ENTRY

Position : LONG

Underlying : ${symbol}

Spot Price : ${price}

Selected :
${option.strike} ${option.optionType}

Qty : ${process.env.LOT_SIZE}

No real order placed.`,
        );

        break;
      }
      case "SHORT_ENTRY": {
        if (currentPosition !== null) {
          await sendTelegram(
            `⚠️ SHORT_ENTRY ignored

Current Position : ${currentPosition}`,
          );

          return res.status(200).send("Position already open");
        }

        currentPosition = "SHORT";
        logger.info("Position changed to SHORT");

        savePosition({
          currentPosition,
        });

        const option = getOptionDetails(signal, price);

        logger.info(`Selected Option: ${option.strike} ${option.optionType}`);

        await sendTelegram(
          `${emoji} PAPER TRADE

Signal : SHORT_ENTRY

Position : SHORT

Underlying : ${symbol}

Spot Price : ${price}

Selected :
${option.strike} ${option.optionType}

Qty : ${process.env.LOT_SIZE}

No real order placed.`,
        );
        break;
      }

      case "LONG_EXIT":
        if (currentPosition !== "LONG") {
          return res.status(200).send("No LONG position");
        }

        currentPosition = null;
        logger.info("Position closed");

        savePosition({
          currentPosition,
        });

        await sendTelegram(
          `${emoji} PAPER EXIT

Signal : LONG_EXIT

Position Closed`,
        );

        break;

      case "SHORT_EXIT":
        if (currentPosition !== "SHORT") {
          return res.status(200).send("No SHORT position");
        }

        currentPosition = null;

        savePosition({
          currentPosition,
        });

        await sendTelegram(
          `${emoji} PAPER EXIT

Signal : SHORT_EXIT

Position Closed`,
        );

        break;

      default:
        return res.status(400).send("Unknown signal");
    }

    console.log(`Current Position = ${currentPosition}`);

    res.status(200).send("Webhook processed");
  } catch (error) {
    logger.error(error.message);

    res.status(500).send("Webhook failed");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
