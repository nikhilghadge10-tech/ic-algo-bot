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
    const response = await axios.post(
      "https://api.dhan.co/v2/orders",
      orderData,
      {
        headers,
      },
    );

    return response.data;
  } catch (error) {
    console.error("Dhan Order Error:", error.response?.data || error.message);

    throw error;
  }
}

module.exports = {
  getProfile,
  placeOrder,
};
