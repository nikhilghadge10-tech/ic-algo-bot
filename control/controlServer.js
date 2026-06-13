const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = 4000;

const envPath = path.join(__dirname, "..", ".env");
const axios = require("axios");

let algoProcess = null;
let ngrokProcess = null;
let ngrokUrl = "";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function readEnv() {
  const content = fs.readFileSync(envPath, "utf8");
  const result = {};

  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const [key, ...rest] = trimmed.split("=");
    result[key] = rest.join("=");
  });

  return result;
}

function writeEnv(updates) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;

    const [key] = trimmed.split("=");

    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      return `${key}=${updates[key]}`;
    }

    return line;
  });

  fs.writeFileSync(envPath, updatedLines.join("\n"));
}

app.get("/api/config", (req, res) => {
  const env = readEnv();

  res.json({
    ALLOW_BUY: env.ALLOW_BUY,
    ALLOW_SELL: env.ALLOW_SELL,
    PAPER_TRADE: env.PAPER_TRADE,
    NO_TRADE_TODAY: env.NO_TRADE_TODAY,

    MAX_DAILY_TRADES: env.MAX_DAILY_TRADES,
    MAX_OPEN_POSITIONS: env.MAX_OPEN_POSITIONS,

    NUMBER_OF_LOTS: env.NUMBER_OF_LOTS,
    LOT_SIZE: env.LOT_SIZE,

    TRADING_CAPITAL: env.TRADING_CAPITAL,
    RISK_MODE: env.RISK_MODE,
    RISK_PERCENT: env.RISK_PERCENT,
    PLANNING_SL_POINTS: env.PLANNING_SL_POINTS,
    MARKET_BIAS: env.MARKET_BIAS,

    algoRunning: !!algoProcess,
    ngrokRunning: !!ngrokProcess,
  });
});

app.post("/api/config", (req, res) => {
  writeEnv(req.body);
  res.json({ success: true });
});

app.post("/api/start-server", (req, res) => {
  if (algoProcess) {
    return res.json({ success: true, message: "Algo server already running" });
  }

  algoProcess = spawn("node", ["src/server.js"], {
    cwd: path.join(__dirname, ".."),
    shell: true,
    stdio: "inherit",
  });

  algoProcess.on("exit", () => {
    algoProcess = null;
  });

  res.json({ success: true, message: "Algo server started" });
});

app.post("/api/stop-server", (req, res) => {
  if (!algoProcess) {
    return res.json({ success: true, message: "Algo server not running" });
  }

  algoProcess.kill();
  algoProcess = null;

  res.json({ success: true, message: "Algo server stopped" });
});

app.post("/api/start-ngrok", (req, res) => {
  if (ngrokProcess) {
    return res.json({ success: true, message: "Ngrok already running" });
  }

  ngrokProcess = spawn("ngrok", ["http", "3000"], {
    shell: true,
    stdio: "inherit",
  });

  ngrokProcess.on("exit", () => {
    ngrokProcess = null;
  });

  res.json({ success: true, message: "Ngrok started" });
});

app.post("/api/stop-ngrok", (req, res) => {
  if (!ngrokProcess) {
    return res.json({ success: true, message: "Ngrok not running" });
  }

  ngrokProcess.kill();
  ngrokProcess = null;

  res.json({ success: true, message: "Ngrok stopped" });
});

app.get("/api/algo-status", async (req, res) => {
  try {
    const response = await axios.get("http://localhost:3000/status", {
      timeout: 2000,
    });

    res.json({
      running: true,
      ...response.data,
    });
  } catch (error) {
    res.json({
      running: false,
      currentPosition: null,
      lastSignal: "",
      lastSignalTime: "",
      message: "Algo server not reachable",
    });
  }
});

app.get("/api/ngrok-url", async (req, res) => {
  try {
    const response = await axios.get("http://127.0.0.1:4040/api/tunnels");

    const tunnel = response.data.tunnels.find((t) => t.proto === "https");

    const url = tunnel ? tunnel.public_url + "/webhook" : "";

    res.json({
      success: true,
      url,
    });
  } catch (error) {
    res.json({
      success: false,
      url: "",
    });
  }
});

app.post("/api/emergency-stop", (req, res) => {
  writeEnv({
    ALLOW_BUY: "false",
    ALLOW_SELL: "false",
    NO_TRADE_TODAY: "true",
  });

  res.json({
    success: true,
    message: "🚨 Emergency stop activated. Trading disabled.",
  });
});

app.listen(PORT, () => {
  console.log(`Control dashboard running at http://localhost:${PORT}`);
});
