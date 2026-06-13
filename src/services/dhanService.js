const axios = require("axios");

const headers = {
  "access-token": process.env.DHAN_ACCESS_TOKEN,
  "client-id": process.env.DHAN_CLIENT_ID,
};

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

async function checkDhanHealth() {
  try {
    const response = await axios.get("https://api.dhan.co/v2/profile", {
      headers: {
        "access-token": process.env.DHAN_ACCESS_TOKEN,
      },
      timeout: 5000,
    });

    return {
      connected: true,
      clientId: response.data.dhanClientId,
      message: "Connected",
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
