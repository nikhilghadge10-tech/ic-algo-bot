/*
 * Contains small Dhan API helper calls used outside the main order service.
 * The control panel uses the health check to show broker connectivity.
 * The profile route is useful for manually verifying the access token.
 * placeOrder is a legacy generic helper; active trades use dhanOrderService.
 */
const axios = require("axios");
const {
  getDhanHeaders,
  getDhanRuntimeConfig,
  getDhanUrl,
  requireDhanRuntimeConfig,
} = require("./dhanRuntimeConfig");

// Fetches the Dhan profile to prove the configured credentials are accepted.
async function getProfile() {
  try {
    const config = requireDhanRuntimeConfig();
    const response = await axios.get(getDhanUrl("/v2/profile", config), {
      headers: getDhanHeaders(config),
    });

    return response.data;
  } catch (error) {
    console.error("Dhan Profile Error:", error.response?.data || error.message);

    throw error;
  }
}

// Generic order helper kept for compatibility; specific order helpers are preferred.
async function placeOrder(orderData) {
  try {
    const response = await axios.post(url, payload, {
      headers: {
        "access-token": process.env.DHAN_ACCESS_TOKEN,
      },
    });

    logger.info(`DHAN SUCCESS: ${JSON.stringify(response.data)}`);

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    logger.error(
      `DHAN FAILED: ${
        error.response ? JSON.stringify(error.response.data) : error.message
      }`,
    );

    return {
      success: false,
      error: error.response ? error.response.data : error.message,
    };
  }
}

// Lightweight broker connectivity check shown in the dashboard.
async function checkDhanHealth() {
  const config = getDhanRuntimeConfig();

  if (!config.configured) {
    return {
      connected: false,
      environment: config.environment,
      configured: false,
      message: `${config.environment} credentials not configured`,
    };
  }

  try {
    const response = await axios.get(getDhanUrl("/v2/profile", config), {
      headers: getDhanHeaders(config),
      timeout: 5000,
    });
    const profileClientId = String(response.data.dhanClientId || "");
    const configuredClientId = config.clientId;
    const connected =
      profileClientId && configuredClientId && profileClientId === configuredClientId;

    return {
      connected,
      configured: true,
      environment: config.environment,
      clientId: profileClientId,
      configuredClientId,
      message: connected
        ? "Connected"
        : "Dhan client ID does not match the active token",
    };
  } catch (error) {
    return {
      connected: false,
      configured: true,
      environment: config.environment,
      message: error.response?.data?.errorMessage || error.message,
    };
  }
}

module.exports = {
  getProfile,
  placeOrder,
  checkDhanHealth,
};
