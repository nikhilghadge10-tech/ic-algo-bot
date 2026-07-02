#!/usr/bin/env node

const http = require("http");

const CONTROL_HOST = "localhost";
const CONTROL_PORT = 4000;
const ALGO_HOST = "localhost";
const ALGO_PORT = 3000;
const PRICE = Number(process.env.TEST_PRICE || 24085.7);
const SYMBOL = process.env.TEST_SYMBOL || process.env.UNDERLYING_SYMBOL || "NIFTY";
const WAIT_MS = Number(process.env.TEST_WAIT_MS || 1200);

const args = new Set(process.argv.slice(2));
const shouldRunPaper = !args.has("--live-only");
const shouldRunLive = args.has("--live") || args.has("--live-only");
const confirmLive = args.has("--confirm-live");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson({ host, port, path, method = "GET", body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        host,
        port,
        path,
        method,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode,
              data: data ? JSON.parse(data) : null,
              raw: data,
            });
          } catch (error) {
            resolve({ statusCode: res.statusCode, data: null, raw: data });
          }
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function control(path, options = {}) {
  return requestJson({
    host: CONTROL_HOST,
    port: CONTROL_PORT,
    path,
    ...options,
  });
}

async function algoStatus() {
  return requestJson({
    host: ALGO_HOST,
    port: ALGO_PORT,
    path: "/status",
  });
}

function printStatus(label, status) {
  const limit = status.dailyTradeLimit || {};
  const trades = Array.isArray(status.lastTrades) ? status.lastTrades : [];

  console.log(`\n[${label}]`);
  console.log(`mode=${status.tradeMode} paperTrade=${status.paperTrade}`);
  console.log(
    `currentPosition=${status.currentPosition || "NONE"} storedPositionMode=${
      status.storedPositionMode || "-"
    }`,
  );
  console.log(`tradesToday=${limit.entryCount ?? "-"} / ${limit.limit ?? "-"}`);
  console.log(
    `lastTrades=${trades.length ? trades.map((t) => `${t.label}:${t.displayStatus}`).join(", ") : "-"}`,
  );
}

async function startAlgoIfNeeded() {
  const config = await control("/api/config");
  if (config.statusCode !== 200) {
    throw new Error(`Control dashboard not reachable on ${CONTROL_PORT}`);
  }

  if (config.data.algoRunning) {
    return;
  }

  console.log("Starting algo server from dashboard...");
  const started = await control("/api/start-server", {
    method: "POST",
    body: {},
  });

  if (!started.data?.success) {
    throw new Error(`Unable to start algo server: ${started.raw}`);
  }

  await sleep(WAIT_MS);
}

async function setPaperTrade(enabled) {
  const result = await control("/api/config", {
    method: "POST",
    body: { PAPER_TRADE: enabled ? "true" : "false" },
  });

  if (!result.data?.success) {
    throw new Error(`Unable to update PAPER_TRADE: ${result.raw}`);
  }

  await sleep(300);
}

async function sendSignal(signal, mode) {
  console.log(`Sending ${mode} ${signal}...`);
  const result = await control("/api/test-signal", {
    method: "POST",
    body: {
      signal,
      source: "MANUAL_SIGNAL",
      symbol: SYMBOL,
      price: PRICE,
      time: new Date().toISOString(),
    },
  });

  console.log(`  success=${!!result.data?.success} ${result.data?.message || ""}`);
  if (result.data?.warning) {
    console.log(`  warning=${result.data.warning} error=${result.data.error || ""}`);
  }
  if (!result.data?.success) {
    console.log(`  raw=${result.raw}`);
  }

  await sleep(WAIT_MS);
}

async function ensureFlat(mode) {
  const statusResult = await algoStatus();
  if (statusResult.statusCode !== 200) {
    throw new Error(`Algo server not reachable on ${ALGO_PORT}`);
  }

  const position = statusResult.data.currentPosition;
  if (!position) {
    return;
  }

  const exitSignal = position === "LONG" ? "LONG_EXIT" : "SHORT_EXIT";
  console.log(`${mode} has open ${position}; sending ${exitSignal} first...`);
  await sendSignal(exitSignal, mode);
}

async function runRoundTrip({ mode, paperTrade }) {
  console.log(`\n=== ${mode} manual signal smoke test ===`);
  await setPaperTrade(paperTrade);

  printStatus("before", (await algoStatus()).data);
  await ensureFlat(mode);
  printStatus("flat", (await algoStatus()).data);

  await sendSignal("LONG_ENTRY", mode);
  printStatus("after LONG_ENTRY", (await algoStatus()).data);

  await sendSignal("LONG_EXIT", mode);
  printStatus("after LONG_EXIT", (await algoStatus()).data);
}

async function main() {
  if (shouldRunLive && !confirmLive) {
    throw new Error(
      "LIVE mode can place real Dhan orders. Re-run with --live --confirm-live if you really want that.",
    );
  }

  await startAlgoIfNeeded();

  if (shouldRunPaper) {
    await runRoundTrip({ mode: "PAPER", paperTrade: true });
  }

  if (shouldRunLive) {
    await runRoundTrip({ mode: "LIVE", paperTrade: false });
  }

  console.log("\nDone. Refresh the dashboard logs/status.");
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exitCode = 1;
});
