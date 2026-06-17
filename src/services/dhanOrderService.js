/*
 * Builds and submits Dhan order requests for the algo bot.
 * Entry orders use BUY because the strategy buys the selected option contract.
 * Exit orders use SELL against the stored security id and quantity.
 * Protective premium stop-loss orders use SELL STOP_LOSS_MARKET.
 * Paper mode returns a successful mock response without calling Dhan.
 */
const axios = require("axios");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const envPath = path.join(__dirname, "..", "..", ".env");

function getRuntimeEnv() {
  try {
    return {
      ...process.env,
      ...dotenv.parse(fs.readFileSync(envPath)),
    };
  } catch (error) {
    logger.warn(`Unable to read Dhan order runtime config: ${error.message}`);
    return process.env;
  }
}

function isPaperTrade(env = getRuntimeEnv()) {
  return String(env.PAPER_TRADE).toLowerCase() === "true";
}

// Keep Dhan error responses in one consistent shape for the webhook logic.
function handleDhanError(error, payload, orderSide) {
  const errorDetails = error.response?.data || error.message;

  logger.error(
    `DHAN ${orderSide} ERROR status=${error.response?.status || "n/a"} details=${JSON.stringify(errorDetails)}`,
  );

  return {
    success: false,
    side: orderSide,
    payload,
    status: error.response?.status,
    error: errorDetails,
  };
}

// Place a market BUY order for the selected option contract.
async function placeMarketBuyOrder(contract, quantity) {
  const env = getRuntimeEnv();

  // Dhan expects these exact field names for an F&O intraday market order.
  const payload = {
    dhanClientId: env.DHAN_CLIENT_ID,
    transactionType: "BUY",
    exchangeSegment: "NSE_FNO",
    productType: "INTRADAY",
    orderType: "MARKET",
    validity: "DAY",
    securityId: contract.SEM_SMST_SECURITY_ID,
    quantity,
  };

  // Paper trading stops here and returns the payload for logging/debugging.
  if (isPaperTrade(env)) {
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

  // Live mode submits the order to Dhan and passes back the broker response.
  try {
    const response = await axios.post(
      "https://api.dhan.co/v2/orders",
      payload,
      {
        headers: {
          "access-token": env.DHAN_ACCESS_TOKEN,
          "client-id": env.DHAN_CLIENT_ID,
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

// Place a market SELL order to close the currently stored option position.
async function placeMarketSellOrder(securityId, quantity) {
  const env = getRuntimeEnv();

  // Exits only need the security id and quantity because the contract was saved at entry.
  const payload = {
    dhanClientId: env.DHAN_CLIENT_ID,
    transactionType: "SELL",
    exchangeSegment: "NSE_FNO",
    productType: "INTRADAY",
    orderType: "MARKET",
    validity: "DAY",
    securityId,
    quantity,
  };

  // Paper exits mirror live exits but avoid the broker API call.
  if (isPaperTrade(env)) {
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

  // Live exit order. The caller decides whether to clear local position state.
  try {
    const response = await axios.post(
      "https://api.dhan.co/v2/orders",
      payload,
      {
        headers: {
          "access-token": env.DHAN_ACCESS_TOKEN,
          "client-id": env.DHAN_CLIENT_ID,
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

async function placeStopLossMarketSellOrder(securityId, quantity, triggerPrice) {
  const env = getRuntimeEnv();

  const payload = {
    dhanClientId: env.DHAN_CLIENT_ID,
    transactionType: "SELL",
    exchangeSegment: "NSE_FNO",
    productType: "INTRADAY",
    orderType: "STOP_LOSS_MARKET",
    validity: "DAY",
    securityId,
    quantity,
    triggerPrice,
  };

  if (isPaperTrade(env)) {
    console.log("\n==============================");
    console.log("PAPER STOP LOSS SELL ORDER");
    console.log("==============================");
    console.log(payload);
    console.log("==============================\n");

    return {
      success: true,
      paperTrade: true,
      data: {
        orderId: `PAPER-SL-${Date.now()}`,
        orderStatus: "PENDING",
      },
      payload,
    };
  }

  try {
    const response = await axios.post(
      "https://api.dhan.co/v2/orders",
      payload,
      {
        headers: {
          "access-token": env.DHAN_ACCESS_TOKEN,
          "client-id": env.DHAN_CLIENT_ID,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("DHAN STOP LOSS SELL RESPONSE");
    console.log(response.data);

    return {
      success: true,
      data: response.data,
      payload,
    };
  } catch (error) {
    return handleDhanError(error, payload, "STOP_LOSS_SELL");
  }
}

async function cancelOrder(orderId) {
  const env = getRuntimeEnv();

  if (!orderId) {
    return {
      success: true,
      skipped: true,
    };
  }

  if (isPaperTrade(env) || String(orderId).startsWith("PAPER-")) {
    console.log("\n==============================");
    console.log("PAPER CANCEL ORDER");
    console.log("==============================");
    console.log({ orderId });
    console.log("==============================\n");

    return {
      success: true,
      paperTrade: true,
      data: {
        orderId,
        orderStatus: "CANCELLED",
      },
    };
  }

  try {
    const response = await axios.delete(
      `https://api.dhan.co/v2/orders/${orderId}`,
      {
        headers: {
          "access-token": env.DHAN_ACCESS_TOKEN,
          "client-id": env.DHAN_CLIENT_ID,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("DHAN CANCEL ORDER RESPONSE");
    console.log(response.data);

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    return handleDhanError(error, { orderId }, "CANCEL");
  }
}

async function getOrderStatus(orderId) {
  const env = getRuntimeEnv();

  if (!orderId) {
    return {
      success: false,
      error: "Order id is required",
    };
  }

  if (isPaperTrade(env) || String(orderId).startsWith("PAPER-")) {
    return {
      success: true,
      paperTrade: true,
      data: {
        orderId,
        orderStatus: "PENDING",
      },
    };
  }

  try {
    const response = await axios.get(
      `https://api.dhan.co/v2/orders/${orderId}`,
      {
        headers: {
          "access-token": env.DHAN_ACCESS_TOKEN,
          "client-id": env.DHAN_CLIENT_ID,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("DHAN ORDER STATUS RESPONSE");
    console.log(response.data);

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    return handleDhanError(error, { orderId }, "ORDER_STATUS");
  }
}

module.exports = {
  cancelOrder,
  getOrderStatus,
  placeMarketBuyOrder,
  placeMarketSellOrder,
  placeStopLossMarketSellOrder,
};
