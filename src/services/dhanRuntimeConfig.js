const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", "..", ".env");
const LIVE_BASE_URL = "https://api.dhan.co";
const SANDBOX_BASE_URL = "https://sandbox.dhan.co";
const SANDBOX_CLIENT_ID = "2601312809";

function getRuntimeEnv() {
  try {
    return {
      ...process.env,
      ...dotenv.parse(fs.readFileSync(envPath)),
    };
  } catch (error) {
    return process.env;
  }
}

function normalizeDhanEnvironment(value) {
  return String(value || "").toUpperCase() === "SANDBOX"
    ? "SANDBOX"
    : "LIVE";
}

function getDhanRuntimeConfig() {
  const env = getRuntimeEnv();
  const environment = normalizeDhanEnvironment(env.DHAN_ENV);
  const sandbox = environment === "SANDBOX";
  const clientId = sandbox
    ? SANDBOX_CLIENT_ID
    : env.DHAN_CLIENT_ID;
  const accessToken = sandbox
    ? env.DHAN_SANDBOX_ACCESS_TOKEN
    : env.DHAN_ACCESS_TOKEN;
  const baseUrl = sandbox
    ? String(env.DHAN_SANDBOX_BASE_URL || SANDBOX_BASE_URL).replace(/\/+$/, "")
    : LIVE_BASE_URL;

  return {
    env,
    environment,
    sandbox,
    baseUrl,
    clientId: String(clientId || "").trim(),
    accessToken: String(accessToken || "").trim(),
    configured: Boolean(clientId && accessToken),
  };
}

function requireDhanRuntimeConfig() {
  const config = getDhanRuntimeConfig();

  if (!config.configured) {
    throw new Error(
      `${config.environment} Dhan credentials are not configured`,
    );
  }

  return config;
}

// Market quotes and candles always come from Dhan's production data APIs.
// Order routing still follows DHAN_ENV, so Sandbox orders remain isolated.
function requireDhanMarketDataConfig() {
  const env = getRuntimeEnv();
  const config = {
    env,
    environment: "LIVE",
    sandbox: false,
    baseUrl: LIVE_BASE_URL,
    clientId: String(env.DHAN_CLIENT_ID || "").trim(),
    accessToken: String(env.DHAN_ACCESS_TOKEN || "").trim(),
    configured: Boolean(env.DHAN_CLIENT_ID && env.DHAN_ACCESS_TOKEN),
  };

  if (!config.configured) {
    throw new Error("LIVE Dhan credentials are required for market data");
  }

  return config;
}

function getDhanHeaders(config = requireDhanRuntimeConfig()) {
  return {
    "access-token": config.accessToken,
    "client-id": config.clientId,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function getDhanUrl(endpoint, config = requireDhanRuntimeConfig()) {
  const pathName = String(endpoint || "").startsWith("/")
    ? String(endpoint)
    : `/${endpoint}`;

  return `${config.baseUrl}${pathName}`;
}

module.exports = {
  getDhanHeaders,
  getDhanRuntimeConfig,
  getDhanUrl,
  getRuntimeEnv,
  normalizeDhanEnvironment,
  requireDhanMarketDataConfig,
  requireDhanRuntimeConfig,
  SANDBOX_CLIENT_ID,
};
