const axios = require("axios");

function handleDhanError(error, payload, orderSide) {
  console.log(`DHAN ${orderSide} ERROR STATUS:`, error.response?.status);
  console.log(`DHAN ${orderSide} ERROR DATA:`, error.response?.data);
  console.log(`DHAN ${orderSide} ERROR MESSAGE:`, error.message);

  return {
    success: false,
    side: orderSide,
    payload,
    status: error.response?.status,
    error: error.response?.data || error.message,
  };
}

async function placeMarketBuyOrder(contract, quantity) {
  const payload = {
    dhanClientId: process.env.DHAN_CLIENT_ID,
    transactionType: "BUY",
    exchangeSegment: "NSE_FNO",
    productType: "INTRADAY",
    orderType: "MARKET",
    validity: "DAY",
    securityId: contract.SEM_SMST_SECURITY_ID,
    quantity,
  };

  if (process.env.PAPER_TRADE === "true") {
    console.log("\n==============================");
    console.log("PAPER ORDER");
    console.log("==============================");
    console.log(payload);
    console.log("==============================\n");

    return {
      success: true,
      paperTrade: true,
      payload,
    };
  }

  console.log("\n==============================");
  console.log("LIVE BUY ORDER");
  console.log("==============================");
  console.log(payload);
  console.log("==============================\n");

  try {
    const response = await axios.post(
      "https://api.dhan.co/v2/orders",
      payload,
      {
        headers: {
          "access-token": process.env.DHAN_ACCESS_TOKEN,
          "client-id": process.env.DHAN_CLIENT_ID,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("DHAN BUY RESPONSE");
    console.log(response.data);

    return {
      success: true,
      data: response.data,
      payload,
    };
  } catch (error) {
    return handleDhanError(error, payload, "BUY");
  }
}

async function placeMarketSellOrder(securityId, quantity) {
  const payload = {
    dhanClientId: process.env.DHAN_CLIENT_ID,
    transactionType: "SELL",
    exchangeSegment: "NSE_FNO",
    productType: "INTRADAY",
    orderType: "MARKET",
    validity: "DAY",
    securityId,
    quantity,
  };

  if (process.env.PAPER_TRADE === "true") {
    console.log("\n==============================");
    console.log("PAPER SELL ORDER");
    console.log("==============================");
    console.log(payload);
    console.log("==============================\n");

    return {
      success: true,
      paperTrade: true,
      payload,
    };
  }

  try {
    const response = await axios.post(
      "https://api.dhan.co/v2/orders",
      payload,
      {
        headers: {
          "access-token": process.env.DHAN_ACCESS_TOKEN,
          "client-id": process.env.DHAN_CLIENT_ID,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("DHAN SELL RESPONSE");
    console.log(response.data);

    return {
      success: true,
      data: response.data,
      payload,
    };
  } catch (error) {
    return handleDhanError(error, payload, "SELL");
  }
}

module.exports = {
  placeMarketBuyOrder,
  placeMarketSellOrder,
};
