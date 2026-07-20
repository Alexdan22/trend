require("dotenv").config();

const MetaApi = require("metaapi.cloud-sdk").default;
const { connectDB } = require("../db");
const { IndependentAiMarketAnalyst } = require("../services/aiAnalyst/analyst");
const { loadAiAnalystConfig } = require("../services/aiAnalyst/config");
const { MongoAiAnalystRepository } = require("../services/aiAnalyst/repository");

function parseLimit(argv) {
  const item = argv.find((arg) => arg.startsWith("--limit="));
  const value = Number(item?.split("=")[1] || 2);
  return Math.max(1, Math.min(6, Number.isFinite(value) ? value : 2));
}

function argValue(name) {
  const item = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return item ? item.slice(name.length + 3) : null;
}

function boundedPeriod() {
  const to = argValue("to") ? new Date(argValue("to")) : new Date();
  const from = argValue("from") ? new Date(argValue("from")) : new Date(to.getTime() - 14 * 86_400_000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error("Invalid --from/--to period");
  if (to - from > 31 * 86_400_000) throw new Error("Replay query period cannot exceed 31 days");
  return { from, to };
}

async function candidates(db, collectionName, from, to, limit) {
  const rows = await db.collection(collectionName).find(
    { openedAt: { $gte: from, $lte: to }, closedAt: { $type: "date" }, tradeId: { $type: "string" } },
    {
      projection: {
        _id: 0, tradeId: 1, executionMode: 1, sessionLabel: 1, side: 1, symbol: 1,
        entryPrice: 1, exitPrice: 1, sl: 1, tp: 1, openedAt: 1, closedAt: 1, durationSec: 1,
        closingReason: 1, result: 1, netPnL: 1, realizedR: 1,
        partialClosed: 1, breakEvenActive: 1, entryScore: 1, entryReason: 1, entryMeta: 1,
      },
    },
  ).sort({ closedAt: -1 }).limit(Math.min(limit * 5, 30)).toArray();
  const output = [];
  for (const row of rows) {
    const linked = await db.collection("ai_signal_trade_links").findOne({ tradeId: row.tradeId }, { projection: { _id: 1 } });
    if (!linked) output.push(row);
    if (output.length >= limit) break;
  }
  return output;
}

async function telegramNotifier(enabled) {
  if (!enabled) return null;
  const { initTelegramBot, getBot } = require("../telegram");
  await initTelegramBot({ polling: false, commands: false });
  const chatId = process.env.TELEGRAM_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("Telegram smoke requested but no report chat is configured");
  let remaining = 2;
  return async (message) => {
    if (remaining <= 0) return;
    remaining--;
    await getBot().sendMessage(chatId, message);
  };
}

async function replayOne({ db, account, trade, notify }) {
  const baseConfig = loadAiAnalystConfig();
  if (baseConfig.mode !== "OBSERVE" || !baseConfig.signalsEnabled || !baseConfig.exitsEnabled || !baseConfig.apiKey) {
    throw new Error("Replay execution requires OBSERVE mode, signal/exit flags, and an out-of-band OpenAI key");
  }
  const config = Object.freeze({ ...baseConfig, controlsEnabled: false, telegramEnabled: Boolean(notify) });
  const analyst = new IndependentAiMarketAnalyst({ config, repository: new MongoAiAnalystRepository(() => db), notify });
  const warm = async (cutoff) => {
    analyst.warmup(
      (symbol, timeframe, limit) => account.getHistoricalCandles(symbol, timeframe, new Date(cutoff), limit),
      trade.symbol,
      cutoff,
    );
    await analyst.idle();
  };
  await warm(trade.openedAt);
  const signal = analyst.captureSignal({
    symbol: trade.symbol, price: { bid: null, ask: null }, sessionLabel: trade.sessionLabel,
    observedAt: trade.openedAt,
    deterministicContext: { score: trade.entryScore, reason: trade.entryReason, entryMeta: trade.entryMeta },
  });
  analyst.recordDisposition({
    signalEventId: signal.signalEventId, disposition: "HISTORICAL_REPLAY_LINK",
    tradeId: trade.tradeId, actualDirection: trade.side, actualEntry: trade.entryPrice,
    actualSL: trade.sl, actualTP: trade.tp, executionMode: trade.executionMode,
  });
  await analyst.idle();
  await warm(trade.closedAt);
  analyst.observeExit({
    signalEventId: signal.signalEventId, tradeId: trade.tradeId, symbol: trade.symbol,
    price: { bid: null, ask: null }, sessionLabel: trade.sessionLabel, observedAt: trade.closedAt,
    finalOutcome: {
      exitPrice: trade.exitPrice ?? null, closedAt: trade.closedAt, durationSec: trade.durationSec,
      closingReason: trade.closingReason, result: trade.result, netPnL: trade.netPnL,
      realizedR: trade.realizedR, partialClosed: trade.partialClosed, breakEvenActive: trade.breakEvenActive,
    },
  });
  await analyst.idle();
  return { tradeId: trade.tradeId, signalEventId: signal.signalEventId };
}

async function main() {
  const db = await connectDB();
  const limit = parseLimit(process.argv);
  const { from, to } = boundedPeriod();
  const [live, shadow] = await Promise.all([
    candidates(db, "trades", from, to, limit),
    candidates(db, "shadow_trades", from, to, limit),
  ]);
  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify({ mode: "DRY_RUN", boundedLimitPerCollection: limit, from, to, live, shadow }, null, 2));
    return;
  }
  if (!process.argv.includes("--confirm=RUN_AI_REPLAY")) throw new Error("Replay execution requires --confirm=RUN_AI_REPLAY");
  const selected = argValue("collection");
  if (!['trades', 'shadow_trades'].includes(selected)) throw new Error("Execute one bounded collection at a time with --collection=trades or --collection=shadow_trades");
  const selectedRows = selected === "trades" ? live : shadow;
  if (selectedRows.length !== 1 || limit !== 1) throw new Error("Executable replay is limited to exactly one unlinked trade per run");
  if (!process.env.METAAPI_TOKEN || !process.env.METAAPI_ACCOUNT_ID) throw new Error("MetaApi credentials are required for read-only historical candles");
  const api = new MetaApi(process.env.METAAPI_TOKEN);
  const account = await api.metatraderAccountApi.getAccount(process.env.METAAPI_ACCOUNT_ID);
  const notify = await telegramNotifier(process.argv.includes("--telegram-smoke"));
  const replayed = await replayOne({ db, account, trade: selectedRows[0], notify });
  console.log(JSON.stringify({ mode: "EXECUTED", collection: selected, replayed }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`[AI REPLAY] ${error.message || error}`);
  process.exit(1);
});
