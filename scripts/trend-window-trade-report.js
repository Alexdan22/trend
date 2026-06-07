require("dotenv").config();

const dns = require("dns");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const MetaApi = require("metaapi.cloud-sdk").default;

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function numericArg(name, fallback) {
  const value = Number(argValue(name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function toNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function iso(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function localLabel(value, offsetMinutes = 330) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "N/A";
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return shifted.toISOString().replace("T", " ").slice(0, 16);
}

function money(value) {
  const number = toNumber(value, 0);
  const sign = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${sign}$${Math.abs(number).toFixed(2)}`;
}

function pct(value) {
  return `${toNumber(value, 0).toFixed(1)}%`;
}

function tradePnl(trade) {
  return toNumber(trade.netPnL ?? trade.grossPnL ?? trade.realizedPnL, 0);
}

function normalizeCandle(candle) {
  const time = new Date(candle.time).getTime();
  return {
    time,
    open: toNumber(candle.open),
    high: toNumber(candle.high),
    low: toNumber(candle.low),
    close: toNumber(candle.close),
    volume: toNumber(candle.tickVolume ?? candle.volume ?? candle.realVolume, 0),
  };
}

function calculateEma(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function linearSlope(values) {
  if (values.length < 2) return 0;
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator += (i - meanX) * (values[i] - meanY);
    denominator += (i - meanX) ** 2;
  }

  return denominator ? numerator / denominator : 0;
}

function stdev(values) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function classifyWindow(windowCandles) {
  const closes = windowCandles.map((candle) => candle.close).filter(Number.isFinite);
  if (closes.length < 20) {
    return {
      trend: "UNKNOWN",
      confidence: 0,
      reason: "not_enough_candles",
    };
  }

  const first = closes[0];
  const last = closes[closes.length - 1];
  const change = last - first;
  const slope = linearSlope(closes);
  const volatility = stdev(closes.slice(1).map((close, index) => close - closes[index])) || 1;
  const normalizedSlope = slope / volatility;
  const normalizedChange = change / (volatility * Math.sqrt(closes.length));
  const ema20 = calculateEma(closes, 20);
  const ema50 = calculateEma(closes, 50);
  const emaSignal =
    ema20 != null && ema50 != null ? (ema20 > ema50 ? 1 : ema20 < ema50 ? -1 : 0) : 0;
  const slopeSignal = normalizedSlope > 0.08 ? 1 : normalizedSlope < -0.08 ? -1 : 0;
  const changeSignal = normalizedChange > 0.8 ? 1 : normalizedChange < -0.8 ? -1 : 0;
  const score = emaSignal + slopeSignal + changeSignal;
  const trend = score >= 2 ? "BUY" : score <= -2 ? "SELL" : "MIXED";

  return {
    trend,
    confidence: Math.min(1, Math.abs(score) / 3),
    score,
    first,
    last,
    change,
    slope,
    normalizedSlope,
    normalizedChange,
    ema20,
    ema50,
    emaSignal,
    slopeSignal,
    changeSignal,
  };
}

function detectFlip(preWindow, earlyWindow, fullWindow) {
  const firstHalf = classifyWindow(preWindow.slice(0, Math.floor(preWindow.length / 2)));
  const secondHalf = classifyWindow(preWindow.slice(Math.floor(preWindow.length / 2)));
  const early = classifyWindow(earlyWindow);
  const full = classifyWindow(fullWindow);
  const labels = [firstHalf.trend, secondHalf.trend, early.trend, full.trend];
  const directional = labels.filter((label) => label === "BUY" || label === "SELL");
  const hasBoth = directional.includes("BUY") && directional.includes("SELL");

  return {
    firstHalf: firstHalf.trend,
    secondHalf: secondHalf.trend,
    early: early.trend,
    full: full.trend,
    flipFlag: hasBoth || (secondHalf.trend !== "MIXED" && secondHalf.trend !== full.trend),
  };
}

function findCandleIndexAtOrBefore(candles, timestamp) {
  let index = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time <= timestamp) index = i;
    else break;
  }
  return index;
}

function summarize(rows, label, filterFn) {
  const items = rows.filter(filterFn);
  const pnls = items.map((row) => tradePnl(row.trade));
  const wins = pnls.filter((pnl) => pnl > 0);
  const losses = pnls.filter((pnl) => pnl < 0);
  const grossProfit = wins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0));
  return {
    label,
    trades: items.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: pnls.filter((pnl) => pnl === 0).length,
    net: pnls.reduce((sum, pnl) => sum + pnl, 0),
    winRate: items.length ? (wins.length / items.length) * 100 : 0,
    profitFactor:
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
  };
}

function formatSummary(summary) {
  const pf = summary.profitFactor === Infinity ? "INF" : summary.profitFactor.toFixed(2);
  return `| ${summary.label} | ${summary.trades} | ${summary.wins}/${summary.losses}/${summary.breakeven} | ${money(summary.net)} | ${pct(summary.winRate)} | ${pf} |`;
}

function hypothesisRows(rows) {
  return [
    {
      label: "Actual last week",
      description: "No trend-transition filter",
      filter: () => true,
    },
    {
      label: "Block 80 opposite",
      description: "Skip entries opposite the 80-candle trend; allow aligned and mixed",
      filter: (row) => !row.analysis[80]?.opposite,
    },
    {
      label: "Block 80 flip-risk",
      description: "Skip entries where the 80-candle transition detector flags flip-risk",
      filter: (row) => !row.analysis[80]?.flip?.flipFlag,
    },
    {
      label: "Block 80 opposite OR flip-risk",
      description: "Skip any 80-candle opposite-trend or flip-risk entry",
      filter: (row) => !row.analysis[80]?.opposite && !row.analysis[80]?.flip?.flipFlag,
    },
    {
      label: "Block score-only conflict",
      description: "Only block SCORE entries when 80-candle trend is opposite or flip-risk",
      filter: (row) =>
        row.trade.entryReason !== "SCORE" ||
        (!row.analysis[80]?.opposite && !row.analysis[80]?.flip?.flipFlag),
    },
    {
      label: "Aligned only",
      description: "Take only entries aligned with the 80-candle trend",
      filter: (row) => row.analysis[80]?.aligned,
    },
    {
      label: "Aligned or stable mixed",
      description: "Take aligned entries plus mixed entries when no 80-candle flip-risk is flagged",
      filter: (row) =>
        row.analysis[80]?.aligned ||
        (row.analysis[80]?.mixed && !row.analysis[80]?.flip?.flipFlag),
    },
  ].map((scenario) => ({
    ...summarize(rows, scenario.label, scenario.filter),
    description: scenario.description,
    blocked: rows.length - rows.filter(scenario.filter).length,
  }));
}

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function loadTrades({ days, now }) {
  console.error("[trend-report] connecting to MongoDB");
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
  });
  await client.connect();

  try {
    const db = client.db(process.env.MONGODB_DB_NAME);
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const trades = await db
      .collection("trades")
      .find({
        closedAt: {
          $gte: from,
          $lte: now,
        },
      })
      .sort({ openedAt: 1 })
      .toArray();

    console.error(`[trend-report] loaded ${trades.length} trades`);
    return { trades, from, to: now };
  } finally {
    await client.close();
  }
}

async function loadCandles({ symbol, pageLimit, from, to, contextCandles = 80 }) {
  console.error(`[trend-report] creating MetaAPI client for ${symbol}`);
  const api = new MetaApi(process.env.METAAPI_TOKEN);
  console.error("[trend-report] loading MetaAPI account");
  const account = await withTimeout(
    api.metatraderAccountApi.getAccount(process.env.METAAPI_ACCOUNT_ID),
    20000,
    "MetaAPI getAccount",
  );
  const targetFrom = new Date(from.getTime() - contextCandles * 5 * 60 * 1000);
  const allCandles = [];
  let cursor = new Date(to.getTime() + contextCandles * 5 * 60 * 1000);

  for (let page = 1; page <= 10; page++) {
    console.error(
      `[trend-report] requesting M5 candle page ${page} before ${cursor.toISOString()}`,
    );
    const candles = await withTimeout(
      account.getHistoricalCandles(symbol, "5m", cursor, pageLimit),
      30000,
      "MetaAPI getHistoricalCandles",
    );
    console.error(`[trend-report] received ${candles.length} candles on page ${page}`);

    if (!candles.length) break;

    allCandles.push(...candles);

    const normalized = candles.map(normalizeCandle).filter((candle) => Number.isFinite(candle.time));
    const earliest = Math.min(...normalized.map((candle) => candle.time));
    if (!Number.isFinite(earliest) || earliest <= targetFrom.getTime()) break;

    cursor = new Date(earliest - 1);
  }

  const byTime = new Map();
  for (const candle of allCandles) {
    const normalized = normalizeCandle(candle);
    if (
      [normalized.time, normalized.open, normalized.high, normalized.low, normalized.close].every(
        Number.isFinite,
      )
    ) {
      byTime.set(normalized.time, normalized);
    }
  }

  return [...byTime.values()]
    .filter(
      (candle) =>
        candle.time >= targetFrom.getTime() &&
        candle.time <= to.getTime() + contextCandles * 5 * 60 * 1000,
    )
    .map(normalizeCandle)
    .filter((candle) =>
      [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite),
    )
    .sort((a, b) => a.time - b.time);
}

function analyzeTrades(trades, candles, windows) {
  return trades.map((trade) => {
    const openedAt = new Date(trade.openedAt).getTime();
    const index = findCandleIndexAtOrBefore(candles, openedAt);
    const windowAnalysis = {};

    for (const size of windows) {
      const pre = index >= 0 ? candles.slice(Math.max(0, index - size + 1), index + 1) : [];
      const early = index >= 0 ? pre.slice(-Math.floor(size / 2)) : [];
      const combined =
        index >= 0
          ? candles.slice(Math.max(0, index - size - Math.floor(size / 2) + 1), index + 1)
          : [];
      const trend = classifyWindow(pre);
      const flip = detectFlip(pre, early, combined);
      windowAnalysis[size] = {
        candles: pre.length,
        trend,
        aligned: trend.trend === trade.side,
        opposite:
          (trend.trend === "BUY" && trade.side === "SELL") ||
          (trend.trend === "SELL" && trade.side === "BUY"),
        mixed: trend.trend === "MIXED" || trend.trend === "UNKNOWN",
        flip,
      };
    }

    return {
      trade,
      candleIndex: index,
      openedAt,
      analysis: windowAnalysis,
    };
  });
}

function writeReport({ rows, range, candles, windows, outputFile, offsetMinutes }) {
  const lines = [
    "# Trend Window Trade Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Trade window: ${range.from.toISOString()} to ${range.to.toISOString()} (${offsetMinutes} min offset labels)`,
    `Trades analyzed: ${rows.length}`,
    `M5 candles loaded: ${candles.length} (${iso(candles[0]?.time)} to ${iso(candles.at(-1)?.time)})`,
    "",
    "## Executive Read",
    "",
  ];

  for (const size of windows) {
    const aligned = summarize(rows, `${size} aligned`, (row) => row.analysis[size]?.aligned);
    const opposite = summarize(rows, `${size} opposite`, (row) => row.analysis[size]?.opposite);
    const mixed = summarize(rows, `${size} mixed/unknown`, (row) => row.analysis[size]?.mixed);
    const flip = summarize(rows, `${size} flip-risk`, (row) => row.analysis[size]?.flip?.flipFlag);
    const noFlip = summarize(rows, `${size} no-flip`, (row) => !row.analysis[size]?.flip?.flipFlag);

    lines.push(
      `### ${size} x M5 Candle Window`,
      "",
      "| Bucket | Trades | W/L/BE | Net | WR | PF |",
      "|---|---:|---:|---:|---:|---:|",
      formatSummary(aligned),
      formatSummary(opposite),
      formatSummary(mixed),
      formatSummary(flip),
      formatSummary(noFlip),
      "",
    );
  }

  const scenarios = hypothesisRows(rows);
  lines.push("## Hypothetical Filter Results", "");
  lines.push("| Scenario | Taken | Blocked | W/L/BE | Net | WR | PF |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const scenario of scenarios) {
    const pf =
      scenario.profitFactor === Infinity ? "INF" : scenario.profitFactor.toFixed(2);
    lines.push(
      `| ${scenario.label} | ${scenario.trades} | ${scenario.blocked} | ${scenario.wins}/${scenario.losses}/${scenario.breakeven} | ${money(scenario.net)} | ${pct(scenario.winRate)} | ${pf} |`,
    );
  }

  lines.push("", "### Scenario Notes", "");
  for (const scenario of scenarios) {
    lines.push(`- ${scenario.label}: ${scenario.description}.`);
  }

  lines.push("## Trade Details", "");
  lines.push(
    "| Opened IST | Side | Result | PnL | Score | Reason | 60 Trend | 80 Trend | 60 Flip | 80 Flip |",
  );
  lines.push("|---|---|---|---:|---:|---|---|---|---|---|");

  for (const row of rows) {
    const trade = row.trade;
    lines.push(
      [
        localLabel(trade.openedAt, offsetMinutes),
        trade.side || "",
        trade.closingReason || trade.result || "",
        money(tradePnl(trade)),
        trade.entryScore ?? "",
        trade.entryReason || "UNKNOWN",
        row.analysis[60]?.trend?.trend || "N/A",
        row.analysis[80]?.trend?.trend || "N/A",
        row.analysis[60]?.flip?.flipFlag ? "YES" : "NO",
        row.analysis[80]?.flip?.flipFlag ? "YES" : "NO",
      ]
        .map((value) => ` ${String(value).replace(/\|/g, "/")} `)
        .join("|")
        .replace(/^/, "|")
        .replace(/$/, "|"),
    );
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${lines.join("\n")}\n`);
}

async function main() {
  const dnsServers = argValue("dns-servers");
  if (dnsServers) {
    dns.setServers(dnsServers.split(",").map((item) => item.trim()).filter(Boolean));
  }

  const days = numericArg("days", 7);
  const offsetMinutes = numericArg("offset-minutes", 330);
  const candlePageLimit = numericArg("candle-limit", 1000);
  const symbol = argValue("symbol", process.env.SYMBOL || "XAUUSDm");
  const outputFile = path.resolve(
    __dirname,
    "..",
    argValue("output", path.join("artifacts", "reports", "trend-window-trade-report.md")),
  );
  const nowArg = argValue("to");
  const now = nowArg ? new Date(nowArg) : new Date();

  if (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME) {
    throw new Error("MONGODB_URI or MONGODB_DB_NAME missing in env");
  }
  if (!process.env.METAAPI_TOKEN || !process.env.METAAPI_ACCOUNT_ID) {
    throw new Error("METAAPI_TOKEN or METAAPI_ACCOUNT_ID missing in env");
  }

  const range = await loadTrades({ days, now });
  const candles = await loadCandles({
    symbol,
    pageLimit: candlePageLimit,
    from: range.from,
    to: range.to,
  });
  const windows = [60, 80];
  const rows = analyzeTrades(range.trades, candles, windows);
  const missing = rows.filter((row) => row.candleIndex < 0).length;

  writeReport({
    rows,
    range,
    candles,
    windows,
    outputFile,
    offsetMinutes,
  });

  console.log(
    JSON.stringify(
      {
        symbol,
        days,
        tradeRange: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
        },
        trades: range.trades.length,
        candles: {
          count: candles.length,
          from: iso(candles[0]?.time),
          to: iso(candles.at(-1)?.time),
        },
        missingCandleMatches: missing,
        outputFile,
      },
      null,
      2,
    ),
  );
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
