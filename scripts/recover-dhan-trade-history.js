const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const {
  getDhanHeaders,
  getDhanRuntimeConfig,
  getDhanUrl,
} = require("../src/services/dhanRuntimeConfig");

const root = path.join(__dirname, "..");
const logPath = path.join(root, "logs", "app.log");
const historyPath = path.join(root, "src", "data", "tradeHistory.json");
const recoveryDir = path.join(root, "src", "data", "recovery");

function istDateKeyFromIso(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function dhanTimeToIso(value) {
  if (!value || value === "NA") return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return new Date(`${normalized}+05:30`).toISOString();
}

function parseBotEntries() {
  const entries = [];
  let candidate = null;
  let latestEntry = null;

  fs.readFileSync(logPath, "utf8").split("\n").forEach((line) => {
    const timestamp = line.match(/^(\d{4}-\d{2}-\d{2}T[^ ]+)/)?.[1];
    const contract = line.match(/Selected Contract: (.+?) securityId=(\d+)/);
    if (contract) {
      candidate = {
        optionSymbol: contract[1],
        securityId: contract[2],
        entryTime: timestamp,
        tradeMode: /tradeMode=SANDBOX/.test(line) ? "SANDBOX" : "LIVE",
      };
      return;
    }

    if (candidate) {
      const sizing = line.match(/Entry sizing:.* quantity=(\d+)/);
      if (sizing) candidate.quantity = Number(sizing[1]);
      const fill = line.match(/(LONG|SHORT)_ENTRY actual fill: premium=([0-9.]+)/);
      if (fill) {
        candidate.entrySignal = `${fill[1]}_ENTRY`;
        candidate.entryPrice = Number(fill[2]);
      }
      const position = line.match(/Position changed to (LONG|SHORT)/);
      if (position && candidate.entryPrice) {
        candidate.entrySignal = `${position[1]}_ENTRY`;
        candidate.entryTime = timestamp;
        candidate.dateKey = istDateKeyFromIso(timestamp);
        entries.push(candidate);
        latestEntry = candidate;
        candidate = null;
      }
    }

    if (latestEntry) {
      const slRequest = line.match(/DHAN option SL-Limit request: (\{.*\})/);
      if (slRequest) {
        try {
          const payload = JSON.parse(slRequest[1]);
          latestEntry.quantity = Number(payload.quantity) || latestEntry.quantity;
        } catch (error) {}
      }
      const slAccepted = line.match(/DHAN option SL-Limit accepted: \{"orderId":"([^"]+)"/);
      if (slAccepted) latestEntry.stopLossOrderId = slAccepted[1];
      const slHit = line.match(/Premium stop-loss hit: (\S+)/);
      if (slHit && latestEntry.stopLossOrderId === slHit[1]) {
        latestEntry.exitTimeFromLog = timestamp;
        latestEntry.exitStatus = "SL_HIT";
      }
    }
  });

  return entries.filter((entry) => entry.tradeMode === "LIVE");
}

async function fetchDhanTrades(fromDate, toDate) {
  const config = getDhanRuntimeConfig();
  const trades = [];
  for (let page = 0; page < 50; page += 1) {
    const response = await axios.get(
      getDhanUrl(`/v2/trades/${fromDate}/${toDate}/${page}`, config),
      { headers: getDhanHeaders(config), timeout: 15000 },
    );
    const pageTrades = Array.isArray(response.data) ? response.data : [];
    trades.push(...pageTrades);
    if (pageTrades.length === 0) break;
  }
  return trades;
}

function findClosestExecution(trades, entry, type, afterIso = null) {
  const target = new Date(afterIso || entry.entryTime).getTime();
  return trades
    .filter((trade) =>
      trade.transactionType === type &&
      String(trade.securityId) === String(entry.securityId) &&
      istDateKeyFromIso(dhanTimeToIso(trade.exchangeTime)) === entry.dateKey &&
      (!afterIso || new Date(dhanTimeToIso(trade.exchangeTime)).getTime() >= target),
    )
    .map((trade) => ({
      trade,
      distance: Math.abs(new Date(dhanTimeToIso(trade.exchangeTime)).getTime() - target),
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.trade || null;
}

function recoverRecords(botEntries, dhanTrades) {
  const sequencesByDate = new Map();
  return botEntries.map((entry) => {
    const buy = findClosestExecution(dhanTrades, entry, "BUY");
    if (!buy) return null;
    const buyTime = dhanTimeToIso(buy.exchangeTime);
    let sell = null;
    if (entry.stopLossOrderId) {
      sell = dhanTrades.find((trade) =>
        trade.transactionType === "SELL" &&
        String(trade.orderId) === String(entry.stopLossOrderId),
      ) || null;
    }
    if (!sell) sell = findClosestExecution(dhanTrades, entry, "SELL", buyTime);
    const quantity = Math.min(
      Number(entry.quantity || buy.tradedQuantity),
      Number(buy.tradedQuantity),
      sell ? Number(sell.tradedQuantity) : Number(buy.tradedQuantity),
    );
    const entryPrice = Number(buy.tradedPrice);
    const exitPrice = sell ? Number(sell.tradedPrice) : null;
    const realizedProfit = exitPrice === null
      ? null
      : Number(((exitPrice - entryPrice) * quantity).toFixed(2));

    const sequence = (sequencesByDate.get(entry.dateKey) || 0) + 1;
    sequencesByDate.set(entry.dateKey, sequence);
    return {
      id: `dhan-recovery-${entry.dateKey}-${buy.orderId}`,
      sequence,
      tradeMode: "LIVE",
      dataSource: "DHAN_TRADE_HISTORY_RECOVERY",
      recoveredAt: new Date().toISOString(),
      status: sell ? (entry.exitStatus || "EXITED") : "RUNNING",
      entrySignal: entry.entrySignal,
      entryTime: buyTime,
      entryOrderId: String(buy.orderId),
      securityId: String(entry.securityId),
      quantity,
      optionSymbol: buy.customSymbol || entry.optionSymbol,
      entryPrice,
      entryPremiumReference: entryPrice,
      stopLossOrderId: entry.stopLossOrderId || null,
      exitSignal: sell ? (entry.exitStatus === "SL_HIT" ? "PREMIUM_SL" : "RECOVERED_EXIT") : null,
      exitTime: sell ? dhanTimeToIso(sell.exchangeTime) : null,
      exitOrderId: sell ? String(sell.orderId) : null,
      exitPrice,
      realizedProfit,
    };
  }).filter(Boolean);
}

async function main() {
  const fromDate = process.argv[2] || "2026-07-06";
  const toDate = process.argv[3] || "2026-07-10";
  fs.mkdirSync(recoveryDir, { recursive: true });
  const botEntries = parseBotEntries().filter(
    (entry) => entry.dateKey >= fromDate && entry.dateKey <= toDate,
  );
  const dhanTrades = await fetchDhanTrades(fromDate, toDate);
  const recovered = recoverRecords(botEntries, dhanTrades);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(recoveryDir, `dhan-trades-${fromDate}-${toDate}-${stamp}.json`),
    JSON.stringify(dhanTrades, null, 2),
  );
  fs.copyFileSync(historyPath, `${historyPath}.backup-before-dhan-recovery-${stamp}`);
  const ledger = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  const existingIds = new Set((ledger.trades || []).map((trade) => trade.id));
  const additions = recovered.filter((trade) => !existingIds.has(trade.id));
  ledger.ledgerVersion = 2;
  ledger.updatedAt = new Date().toISOString();
  ledger.trades = [...(ledger.trades || []), ...additions].sort((a, b) =>
    String(a.entryTime || "").localeCompare(String(b.entryTime || "")),
  );
  const sequenceByDate = new Map();
  ledger.trades.forEach((trade) => {
    const dateKey = istDateKeyFromIso(trade.entryTime || trade.exitTime);
    const sequence = (sequenceByDate.get(dateKey) || 0) + 1;
    sequenceByDate.set(dateKey, sequence);
    trade.sequence = sequence;
  });
  fs.writeFileSync(historyPath, JSON.stringify(ledger, null, 2));
  console.log(JSON.stringify({ botEntries: botEntries.length, dhanExecutions: dhanTrades.length, recovered: recovered.length, added: additions.length }, null, 2));
}

main().catch((error) => {
  console.error(error.response?.data || error.message);
  process.exit(1);
});
