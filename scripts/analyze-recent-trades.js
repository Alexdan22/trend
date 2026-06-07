require("dotenv").config();

process.env.AI_REPORTS_ENABLED = "false";

const dns = require("dns");
const { MongoClient } = require("mongodb");
const {
  buildAnalytics,
  formatTelegramReport,
  getPeriodRange,
} = require("../services/reporting/tradeAnalytics");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function stripHtml(text) {
  return String(text).replace(/<[^>]*>/g, "");
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tradePnl(trade) {
  return toNumber(trade.netPnL ?? trade.grossPnL ?? trade.realizedPnL, 0);
}

function money(value) {
  const number = toNumber(value);
  const sign = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${sign}$${Math.abs(number).toFixed(2)}`;
}

function pct(value) {
  return `${toNumber(value).toFixed(1)}%`;
}

function localParts(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

function localDayKey(value, offsetMinutes) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "UNKNOWN";
  const parts = localParts(date, offsetMinutes);
  return [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function localHourKey(value, offsetMinutes) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "UNKNOWN";
  return String(localParts(date, offsetMinutes).hour).padStart(2, "0");
}

function scoreBucket(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return "NO_SCORE";
  const start = Math.floor(value / 10) * 10;
  return `${start}-${start + 9}`;
}

function groupTrades(trades, keyFn) {
  const groups = new Map();

  for (const trade of trades) {
    const key = keyFn(trade) || "UNKNOWN";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }

  return [...groups.entries()]
    .map(([label, items]) => summarize(items, label))
    .sort((a, b) => b.netPnL - a.netPnL);
}

function summarize(trades, label = "ALL") {
  const pnls = trades.map(tradePnl);
  const wins = pnls.filter((pnl) => pnl > 0);
  const losses = pnls.filter((pnl) => pnl < 0);
  const grossProfit = wins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0));
  const realizedRs = trades
    .map((trade) => Number(trade.realizedR))
    .filter(Number.isFinite);

  return {
    label,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: pnls.filter((pnl) => pnl === 0).length,
    netPnL: pnls.reduce((sum, pnl) => sum + pnl, 0),
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor:
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: trades.length
      ? pnls.reduce((sum, pnl) => sum + pnl, 0) / trades.length
      : 0,
    avgR: realizedRs.length
      ? realizedRs.reduce((sum, value) => sum + value, 0) / realizedRs.length
      : null,
    partials: trades.filter((trade) => trade.partialClosed).length,
  };
}

function printGroup(title, groups, limit = 20) {
  console.log(`\n${title}`);
  for (const group of groups.slice(0, limit)) {
    const pf = group.profitFactor === Infinity ? "INF" : group.profitFactor.toFixed(2);
    const avgR = group.avgR == null ? "N/A" : group.avgR.toFixed(2);
    console.log(
      `${group.label}: trades=${group.trades}, net=${money(
        group.netPnL,
      )}, WR=${pct(group.winRate)}, PF=${pf}, exp=${money(
        group.expectancy,
      )}, avgR=${avgR}, partials=${group.partials}`,
    );
  }
}

async function main() {
  const days = Number(argValue("days", 7));
  const offsetMinutes = Number(argValue("offset-minutes", 330));
  const collectionName = argValue("collection", "trades");
  const dnsServers = argValue("dns-servers");
  const period = argValue("period");
  const nowArg = argValue("to");
  const now = nowArg ? new Date(nowArg) : new Date();

  if (dnsServers) {
    dns.setServers(
      dnsServers
        .split(",")
        .map((server) => server.trim())
        .filter(Boolean),
    );
  }

  if (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME) {
    throw new Error("MONGODB_URI or MONGODB_DB_NAME missing in env");
  }

  if (!period && (!Number.isFinite(days) || days <= 0)) {
    throw new Error("--days must be a positive number");
  }

  if (!Number.isFinite(now.getTime())) {
    throw new Error("--to must be a valid date/time");
  }

  const range = period
    ? getPeriodRange(period, now, offsetMinutes)
    : {
        from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
        to: now,
      };
  const from = range.from;
  const to = range.to;
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
  });

  await client.connect();

  try {
    const db = client.db(process.env.MONGODB_DB_NAME);
    const trades = await db
      .collection(collectionName)
      .find({
        closedAt: {
          $gte: from,
          $lte: to,
        },
      })
      .sort({ closedAt: 1 })
      .toArray();

    const summary = buildAnalytics({
      trades,
      period: period || `${days}-day`,
      from,
      to,
      offsetMinutes,
    });

    console.log(
      JSON.stringify(
        {
          database: process.env.MONGODB_DB_NAME,
          collection: collectionName,
          range: {
            from: from.toISOString(),
            to: to.toISOString(),
            days: period ? null : days,
            period: period || null,
            offsetMinutes,
          },
          trades: trades.length,
        },
        null,
        2,
      ),
    );
    console.log("\n--- REPORT ---\n");
    console.log(stripHtml(formatTelegramReport(summary)));

    console.log("\n--- DEEP BREAKDOWNS ---");
    printGroup(
      "By local day",
      groupTrades(trades, (trade) => localDayKey(trade.closedAt, offsetMinutes)).sort(
        (a, b) => a.label.localeCompare(b.label),
      ),
    );
    printGroup("By entry reason", groupTrades(trades, (trade) => trade.entryReason));
    printGroup("By score bucket", groupTrades(trades, (trade) => scoreBucket(trade.entryScore)));
    printGroup("By side", groupTrades(trades, (trade) => trade.side));
    printGroup(
      "By exit reason",
      groupTrades(trades, (trade) => trade.closingReason || trade.result),
    );
    printGroup(
      "By local entry hour",
      groupTrades(trades, (trade) => localHourKey(trade.openedAt, offsetMinutes)),
    );
    printGroup(
      "By partial outcome",
      groupTrades(trades, (trade) => (trade.partialClosed ? "PARTIAL_CLOSED" : "NO_PARTIAL")),
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
