/*
 * Builds and submits Dhan order requests for the algo bot.
 * Entry orders use BUY because the strategy buys the selected option contract.
 * Exit orders use SELL against the stored security id and quantity.
 * Protective option stop-loss orders use SELL STOP_LOSS (SL-Limit).
 * Paper mode returns a successful mock response without calling Dhan.
 */
const axios = require("axios");
const logger = require("./logger");
const {
  getDhanHeaders,
  getDhanUrl,
  getRuntimeEnv,
  requireDhanRuntimeConfig,
} = require("./dhanRuntimeConfig");

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
    environment: error.dhanEnvironment,
  };
}

async function callDhan(config, request) {
  try {
    return await axios({
      ...request,
      url: getDhanUrl(request.endpoint, config),
      headers: getDhanHeaders(config),
    });
  } catch (error) {
    error.dhanEnvironment = config.environment;
    throw error;
  }
}

// Place a market BUY order for the selected option contract.
async function placeMarketBuyOrder(contract, quantity) {
  const env = getRuntimeEnv();

  // Dhan expects these exact field names for an F&O intraday market order.
  const payload = {
    dhanClientId: "",
    transactionType: "BUY",
    exchangeSegment: "NSE_FNO",
    productType: "INTRADAY",
    orderType: "MARKET",
    validity: "DAY",
    securityId: contract.SEM_SMST_SECURITY_ID,
    quantity,
    disclosedQuantity: 0,
    price: 0,
    triggerPrice: 0,
    afterMarketOrder: false,
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
      data: {
        orderId: `PAPER-BUY-${Date.now()}`,
        orderStatus: "TRADED",
      },
      payload,
    };
  }

  const dhan = requireDhanRuntimeConfig();
  payload.dhanClientId = dhan.clientId;

  console.log("\n==============================");
  console.log("LIVE BUY ORDER");
  console.log("==============================");
  console.log(payload);
  console.log("==============================\n");

  // Live mode submits the order to Dhan and passes back the broker response.
  try {
    const response = await callDhan(dhan, {
      method: "POST",
      endpoint: "/v2/orders",
      data: payload,
    });

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
    dhanClientId: "",
    transactionType: "SELL",
    exchangeSegment: "NSE_FNO",
    productType: "INTRADAY",
    orderType: "MARKET",
    validity: "DAY",
    securityId,
    quantity,
    disclosedQuantity: 0,
    price: 0,
    triggerPrice: 0,
    afterMarketOrder: false,
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
      data: {
        orderId: `PAPER-SELL-${Date.now()}`,
        orderStatus: "TRADED",
      },
      payload,
    };
  }

  const dhan = requireDhanRuntimeConfig();
  payload.dhanClientId = dhan.clientId;

  // Live exit order. The caller decides whether to clear local position state.
  try {
    const response = await callDhan(dhan, {
      method: "POST",
      endpoint: "/v2/orders",
      data: payload,
    });

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

async function placeStopLossLimitSellOrder(
  securityId,
  quantity,
  triggerPrice,
  limitPrice,
) {
  const env = getRuntimeEnv();

  const payload = {
    dhanClientId: "",
    transactionType: "SELL",
    exchangeSegment: "NSE_FNO",
    productType: "INTRADAY",
    orderType: "STOP_LOSS",
    validity: "DAY",
    securityId,
    quantity,
    disclosedQuantity: 0,
    price: limitPrice,
    triggerPrice,
    afterMarketOrder: false,
  };

  if (isPaperTrade(env)) {
    console.log("\n==============================");
    console.log("PAPER STOP LOSS LIMIT SELL ORDER");
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

  const dhan = requireDhanRuntimeConfig();
  payload.dhanClientId = dhan.clientId;

  try {
    logger.info(
      `DHAN option SL-Limit request: ${JSON.stringify({
        transactionType: payload.transactionType,
        exchangeSegment: payload.exchangeSegment,
        productType: payload.productType,
        orderType: payload.orderType,
        validity: payload.validity,
        securityId: payload.securityId,
        quantity: payload.quantity,
        triggerPrice: payload.triggerPrice,
        price: payload.price,
        environment: dhan.environment,
      })}`,
    );

    const response = await callDhan(dhan, {
      method: "POST",
      endpoint: "/v2/orders",
      data: payload,
    });

    console.log("DHAN STOP LOSS SELL RESPONSE");
    console.log(response.data);
    logger.info(
      `DHAN option SL-Limit accepted: ${JSON.stringify(response.data)}`,
    );

    return {
      success: true,
      data: response.data,
      payload,
    };
  } catch (error) {
    return handleDhanError(error, payload, "STOP_LOSS_SELL");
  }
}

async function modifyStopLossLimitSellOrder({
  orderId,
  quantity,
  triggerPrice,
  limitPrice,
}) {
  const env = getRuntimeEnv();

  const payload = {
    dhanClientId: "",
    orderId,
    orderType: "STOP_LOSS",
    validity: "DAY",
    quantity,
    disclosedQuantity: 0,
    price: limitPrice,
    triggerPrice,
  };

  if (isPaperTrade(env) || String(orderId).startsWith("PAPER-")) {
    console.log("\n==============================");
    console.log("PAPER MODIFY STOP LOSS LIMIT SELL ORDER");
    console.log("==============================");
    console.log(payload);
    console.log("==============================\n");

    return {
      success: true,
      paperTrade: true,
      data: {
        orderId,
        orderStatus: "PENDING",
      },
      payload,
    };
  }

  const dhan = requireDhanRuntimeConfig();
  payload.dhanClientId = dhan.clientId;

  try {
    logger.info(
      `DHAN option SL-Limit modify request: ${JSON.stringify({
        orderId: payload.orderId,
        orderType: payload.orderType,
        validity: payload.validity,
        quantity: payload.quantity,
        triggerPrice: payload.triggerPrice,
        price: payload.price,
        environment: dhan.environment,
      })}`,
    );

    const response = await callDhan(dhan, {
      method: "PUT",
      endpoint: `/v2/orders/${orderId}`,
      data: payload,
    });

    console.log("DHAN MODIFY STOP LOSS SELL RESPONSE");
    console.log(response.data);
    logger.info(
      `DHAN option SL-Limit modified: ${JSON.stringify(response.data)}`,
    );

    return {
      success: true,
      data: response.data,
      payload,
    };
  } catch (error) {
    return handleDhanError(error, payload, "MODIFY_STOP_LOSS_SELL");
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

  const dhan = requireDhanRuntimeConfig();

  try {
    const response = await callDhan(dhan, {
      method: "DELETE",
      endpoint: `/v2/orders/${orderId}`,
    });

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

  const dhan = requireDhanRuntimeConfig();

  try {
    const response = await callDhan(dhan, {
      method: "GET",
      endpoint: `/v2/orders/${orderId}`,
    });

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

async function getPositions() {
  const env = getRuntimeEnv();

  if (isPaperTrade(env)) {
    return {
      success: true,
      paperTrade: true,
      data: [],
    };
  }

  const dhan = requireDhanRuntimeConfig();

  try {
    const response = await callDhan(dhan, {
      method: "GET",
      endpoint: "/v2/positions",
    });

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    return handleDhanError(error, {}, "POSITIONS");
  }
}

module.exports = {
  cancelOrder,
  getPositions,
  getOrderStatus,
  modifyStopLossLimitSellOrder,
  placeMarketBuyOrder,
  placeMarketSellOrder,
  placeStopLossLimitSellOrder,
};
