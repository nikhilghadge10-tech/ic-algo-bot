/*
 * Backend for the local control dashboard.
 * Serves the OpenUI5 control panel, reads/writes .env settings, starts/stops
 * the algo server and ngrok tunnel, proxies health checks, and exposes recent
 * logs. This server is for local operations, not broker order placement.
 */
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

// Accept JSON API requests and serve the dashboard assets from control/public.
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Parse .env into a simple key/value object for the dashboard model.
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

// Update existing .env keys while preserving comments and unrelated lines.
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

// Store token update time as readable IST while keeping it Date-parseable.
function getIstIsoString(date = new Date()) {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffsetMs);

  return `${istDate.toISOString().slice(0, 19)}+05:30`;
}

// Dashboard bootstrap endpoint: config plus live process/tunnel status.
app.get("/api/config", async (req, res) => {
  const env = readEnv();

  const algoRunning = await isAlgoActuallyRunning();
  const ngrokHealth = await getNgrokHealth();

  res.json({
    ALLOW_BUY: env.ALLOW_BUY,
    ALLOW_SELL: env.ALLOW_SELL,
    PAPER_TRADE: env.PAPER_TRADE,
    NO_TRADE_TODAY: env.NO_TRADE_TODAY,
    AUTO_PREMIUM_SL: env.AUTO_PREMIUM_SL,
    PREMIUM_SL_INTERVAL: env.PREMIUM_SL_INTERVAL,

    MAX_DAILY_TRADES: env.MAX_DAILY_TRADES,
    MAX_OPEN_POSITIONS: env.MAX_OPEN_POSITIONS,

    NUMBER_OF_LOTS: env.NUMBER_OF_LOTS,
    LOT_SIZE: env.LOT_SIZE,

    TRADING_CAPITAL: env.TRADING_CAPITAL,
    RISK_MODE: env.RISK_MODE,
    RISK_PERCENT: env.RISK_PERCENT,
    PLANNING_SL_POINTS: env.PLANNING_SL_POINTS,
    MARKET_BIAS: env.MARKET_BIAS,

    DHAN_TOKEN_UPDATED_AT: env.DHAN_TOKEN_UPDATED_AT,

    algoRunning,
    ngrokRunning: ngrokHealth.running,
    ngrokUrl: ngrokHealth.url,
  });
});

// Check whether the algo server is responding on its status endpoint.
async function isAlgoActuallyRunning() {
  try {
    await axios.get("http://localhost:3000/status", {
      timeout: 1500,
    });

    return true;
  } catch (error) {
    return false;
  }
}

// Ask ngrok's local API for the current public HTTPS tunnel.
async function getNgrokHealth() {
  try {
    const response = await axios.get("http://127.0.0.1:4040/api/tunnels", {
      timeout: 1500,
    });

    const tunnel = response.data.tunnels.find((t) => t.proto === "https");

    return {
      running: !!tunnel,
      url: tunnel ? tunnel.public_url + "/webhook" : "",
    };
  } catch (error) {
    return {
      running: false,
      url: "",
    };
  }
}

// Save dashboard-edited settings back to .env.
app.post("/api/config", (req, res) => {
  writeEnv(req.body);
  res.json({ success: true });
});

// Start the algo webhook server as a child process.
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

// Stop the child algo server if this dashboard started it.
app.post("/api/stop-server", (req, res) => {
  if (!algoProcess) {
    return res.json({ success: true, message: "Algo server not running" });
  }

  algoProcess.kill();
  algoProcess = null;

  res.json({ success: true, message: "Algo server stopped" });
});

// Start ngrok so TradingView can reach the local webhook.
app.post("/api/start-ngrok", async (req, res) => {
  const health = await getNgrokHealth();

  if (health.running) {
    return res.json({
      success: true,
      message: "Ngrok already running",
    });
  }

  ngrokProcess = spawn("ngrok", ["http", "3000"], {
    shell: true,
    stdio: "inherit",
  });

  ngrokProcess.on("exit", () => {
    ngrokProcess = null;
  });

  res.json({
    success: true,
    message: "Ngrok started",
  });
});

// Stop ngrok, including any process that may have been started separately.
app.post("/api/stop-ngrok", async (req, res) => {
  try {
    if (ngrokProcess) {
      ngrokProcess.kill();
      ngrokProcess = null;
    }

    // kill any existing ngrok process
    spawn("pkill", ["ngrok"], {
      shell: true,
    });

    res.json({
      success: true,
      message: "Ngrok stopped",
    });
  } catch (error) {
    res.json({
      success: false,
      message: error.message,
    });
  }
});

// Proxy the algo server status into the dashboard.
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
      lastTrades: [],
      message: "Algo server not reachable",
    });
  }
});

// Return the current public webhook URL from ngrok's local API.
app.get("/api/ngrok-url", async (req, res) => {
  try {
    const health = await getNgrokHealth();

    res.json({
      success: true,
      running: health.running,
      url: health.url,
    });
  } catch (error) {
    res.json({
      success: false,
      running: false,
      url: "",
    });
  }
});

// Hard safety action: disable entries and block all trading for the day.
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

// Send a dashboard-generated signal to the algo webhook for manual testing.
app.post("/api/test-signal", async (req, res) => {
  try {
    const payload = req.body;

    const response = await axios.post(
      "http://localhost:3000/webhook",
      payload,
      {
        timeout: 5000,
      },
    );

    res.json({
      success: true,
      message: `Test signal sent: ${payload.signal}`,
      response: response.data,
    });
  } catch (error) {
    res.json({
      success: false,
      message: "Test signal failed. Is algo server running?",
      error: error.message,
    });
  }
});

// Return recent log entries newest-first for the dashboard log viewer.
app.get("/api/logs", (req, res) => {
  try {
    const logPath = path.join(__dirname, "..", "logs", "app.log");

    if (!fs.existsSync(logPath)) {
      return res.json({
        success: true,
        logs: "No log file found yet.",
      });
    }

    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    // Keep the response small and show the latest activity first.
    const lastLines = lines
      .slice(-80)
      .reverse()
      .map((line) => {
        return line.replace(
          /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
          (match) => {
            return new Date(match).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              hour12: true,
            });
          },
        );
      })
      .join("\n");

    res.json({
      success: true,
      logs: lastLines,
    });
  } catch (error) {
    res.json({
      success: false,
      logs: error.message,
    });
  }
});

// Proxy Dhan health from the algo server so the dashboard has one API host.
app.get("/api/dhan-health", async (req, res) => {
  try {
    const response = await axios.get("http://localhost:3000/dhan-health", {
      timeout: 5000,
    });

    res.json(response.data);
  } catch (error) {
    res.json({
      connected: false,
      message: "Algo server not reachable",
    });
  }
});

// Fetch NIFTY spot LTP through the algo server for manual signal price prefill.
app.get("/api/nifty-spot", async (req, res) => {
  try {
    const response = await axios.get("http://localhost:3000/nifty-spot", {
      timeout: 5000,
    });

    res.json(response.data);
  } catch (error) {
    res.json({
      success: false,
      message: "NIFTY spot price unavailable",
      error: error.response?.data || error.message,
    });
  }
});

// Store a refreshed Dhan token and timestamp in .env.
app.post("/api/update-dhan-token", (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({
      success: false,
      message: "Token is required",
    });
  }

  writeEnv({
    DHAN_ACCESS_TOKEN: token,
    DHAN_TOKEN_UPDATED_AT: getIstIsoString(),
  });

  res.json({
    success: true,
    message: "Dhan token updated. Restart algo server.",
  });
});

// Start the local dashboard server.
app.listen(PORT, () => {
  console.log(`Control dashboard running at http://localhost:${PORT}`);
});
