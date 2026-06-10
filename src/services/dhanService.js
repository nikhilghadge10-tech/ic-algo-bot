const axios = require("axios");

async function getProfile() {
  try {
    const response = await axios.get("https://api.dhan.co/v2/profile", {
      headers: {
        "access-token": process.env.DHAN_ACCESS_TOKEN,
        "client-id": process.env.DHAN_CLIENT_ID,
      },
    });

    return response.data;
  } catch (error) {
    console.error("Dhan Profile Error:", error.response?.data || error.message);

    throw error;
  }
}

module.exports = {
  getProfile,
};
