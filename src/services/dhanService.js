/*
 * Contains small Dhan API helper calls used outside the main order service.
 * The control panel uses the health check to show broker connectivity.
 * The profile route is useful for manually verifying the access token.
 * placeOrder is a legacy generic helper; active trades use dhanOrderService.
 */
const axios = require("axios");

// Shared headers for simple Dhan GET calls.
const headers = {
  "access-token": process.env.DHAN_ACCESS_TOKEN,
  "client-id": process.env.DHAN_CLIENT_ID,
};

// Fetches the Dhan profile to prove the configured credentials are accepted.
async function getProfile() {
  try {
    const response = await axios.get("https://api.dhan.co/v2/profile", {
      headers,
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
  try {
    const response = await axios.get("https://api.dhan.co/v2/profile", {
      headers: {
        "access-token": process.env.DHAN_ACCESS_TOKEN,
        "client-id": process.env.DHAN_CLIENT_ID,
      },
      timeout: 5000,
    });
    const profileClientId = String(response.data.dhanClientId || "");
    const configuredClientId = String(process.env.DHAN_CLIENT_ID || "");
    const connected =
      profileClientId && configuredClientId && profileClientId === configuredClientId;

    return {
      connected,
      clientId: profileClientId,
      configuredClientId,
      message: connected
        ? "Connected"
        : "Dhan client ID does not match the active token",
    };
  } catch (error) {
    return {
      connected: false,
      message: error.response?.data?.errorMessage || error.message,
    };
  }
}

module.exports = {
  getProfile,
  placeOrder,
  checkDhanHealth,
};
