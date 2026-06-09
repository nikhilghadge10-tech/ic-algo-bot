require("dotenv").config();

const express = require("express");
const { sendTelegram } = require("./services/telegramService");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Algo Bot Running");
});

app.get("/test", async (req, res) => {
  try {
    console.log(process.env.TELEGRAM_BOT_TOKEN);

    await sendTelegram("🚀 Algo Bot Telegram Test Successful");

    res.send("Telegram sent");
  } catch (error) {
    console.error(error);

    res.status(500).send("Telegram failed");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("Webhook received:");
    console.log(req.body);

    const { signal, symbol, price } = req.body;

    await sendTelegram(
      `🚨 Trading Signal

Signal : ${signal}

Symbol : ${symbol}

Price : ${price}`,
    );

    res.status(200).send("Webhook processed");
  } catch (error) {
    console.error(error);

    res.status(500).send("Webhook failed");
  }
});
