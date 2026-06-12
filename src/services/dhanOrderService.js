const axios = require("axios");

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

  // PAPER MODE
  if (process.env.PAPER_TRADE === "true") {
    console.log("\n==============================");
    console.log("PAPER ORDER");
    console.log("==============================");
    console.log(payload);
    console.log("==============================\n");

    return {
      paperTrade: true,
      payload,
    };
  }

  const response = await axios.post("https://api.dhan.co/v2/orders", payload, {
    headers: {
      "access-token": process.env.DHAN_ACCESS_TOKEN,
      "client-id": process.env.DHAN_CLIENT_ID,
      "Content-Type": "application/json",
    },
  });

  console.log("DHAN RESPONSE");
  console.log(response.data);

  return response.data;
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
      paperTrade: true,
      payload,
    };
  }

  const response = await axios.post("https://api.dhan.co/v2/orders", payload, {
    headers: {
      "access-token": process.env.DHAN_ACCESS_TOKEN,
      "client-id": process.env.DHAN_CLIENT_ID,
      "Content-Type": "application/json",
    },
  });

  console.log("DHAN RESPONSE");
  console.log(response.data);

  return response.data;
}

module.exports = {
  placeMarketBuyOrder,
  placeMarketSellOrder,
};
