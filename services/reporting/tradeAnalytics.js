function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sum(values) {
  return values.reduce((total, value) => total + toNumber(value), 0);
}

function avg(values) {
  return values.length ? sum(values) / values.length : 0;
}

function pct(value) {
  return `${toNumber(value).toFixed(1)}%`;
}

function money(value) {
  const number = toNumber(value);
  const sign = number < 0 ? "-" : "";
  return `${sign}$${Math.abs(number).toFixed(2)}`;
}

function compactPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "N/A";
}

function periodLabel(period) {
  if (period === "daily") return "Daily";
  if (period === "weekly") return "Weekly";
  if (period === "monthly") return "Monthly";
  return "Trade";
}

function localDate(date, offsetMinutes) {
  return new Date(date.getTime() + offsetMinutes * 60 * 1000);
}

function localDateParts(date, offsetMinutes) {
  const shifted = localDate(date, offsetMinutes);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    dayOfWeek: shifted.getUTCDay(),
    lastDayOfMonth: new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
    ).getUTCDate(),
  };
}

function utcFromLocalParts(parts, offsetMinutes) {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month,
      parts.day,
      parts.hour || 0,
      parts.minute || 0,
      0,
      0,
    ) -
      offsetMinutes * 60 * 1000,
  );
}

function startOfLocalDay(date, offsetMinutes) {
  const parts = localDateParts(date, offsetMinutes);
  return utcFromLocalParts(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
    },
    offsetMinutes,
  );
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function getPeriodRange(period, now = new Date(), offsetMinutes = 330) {
  const todayStart = startOfLocalDay(now, offsetMinutes);
  const parts = localDateParts(now, offsetMinutes);

  if (period === "weekly") {
    const daysSinceMonday = (parts.dayOfWeek + 6) % 7;
    const start = addDays(todayStart, -daysSinceMonday);
    return {
      from: start,
      to: now,
    };
  }

  if (period === "monthly") {
    return {
      from: utcFromLocalParts(
        {
          year: parts.year,
          month: parts.month,
          day: 1,
        },
        offsetMinutes,
      ),
      to: now,
    };
  }

  return {
    from: todayStart,
    to: now,
  };
}

function formatRange(from, to, offsetMinutes) {
  const options = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  };

  const start = localDate(from, offsetMinutes).toLocaleString("en-GB", options);
  const end = localDate(to, offsetMinutes).toLocaleString("en-GB", options);
  return `${start} - ${end}`;
}

function tradePnl(trade) {
  return toNumber(trade.netPnL ?? trade.grossPnL ?? trade.realizedPnL, 0);
}

function tradeDurationMinutes(trade) {
  if (Number.isFinite(Number(trade.durationSec))) {
    return Number(trade.durationSec) / 60;
  }

  const opened = new Date(trade.openedAt).getTime();
  const closed = new Date(trade.closedAt).getTime();
  if (!Number.isFinite(opened) || !Number.isFinite(closed)) return 0;

  return Math.max(0, (closed - opened) / 60000);
}

function groupBy(trades, keyFn) {
  const map = new Map();

  for (const trade of trades) {
    const key = keyFn(trade) || "UNKNOWN";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(trade);
  }

  return [...map.entries()].map(([key, items]) => summarizeTrades(items, key));
}

function maxDrawdown(pnls) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;

  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }

  return drawdown;
}

function streaks(trades) {
  let currentType = null;
  let current = 0;
  let maxWin = 0;
  let maxLoss = 0;

  for (const trade of trades) {
    const pnl = tradePnl(trade);
    const type = pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "BE";

    if (type === currentType) {
      current += 1;
    } else {
      currentType = type;
      current = 1;
    }

    if (type === "WIN") maxWin = Math.max(maxWin, current);
    if (type === "LOSS") maxLoss = Math.max(maxLoss, current);
  }

  return {
    maxWin,
    maxLoss,
  };
}

function summarizeTrades(trades, label = "ALL") {
  const pnls = trades.map(tradePnl);
  const wins = pnls.filter((pnl) => pnl > 0);
  const losses = pnls.filter((pnl) => pnl < 0);
  const breakeven = pnls.filter((pnl) => pnl === 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));

  return {
    label,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    netPnL: sum(pnls),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: trades.length ? sum(pnls) / trades.length : 0,
    avgWin: avg(wins),
    avgLoss: avg(losses),
    payoffRatio: Math.abs(avg(losses)) > 0 ? avg(wins) / Math.abs(avg(losses)) : 0,
    maxDrawdown: maxDrawdown(pnls),
    avgDurationMinutes: avg(trades.map(tradeDurationMinutes)),
  };
}

function hourBucket(trade, offsetMinutes) {
  const opened = new Date(trade.openedAt);
  if (!Number.isFinite(opened.getTime())) return "UNKNOWN";
  return String(localDateParts(opened, offsetMinutes).hour).padStart(2, "0");
}

function topGroups(groups, count = 3, minTrades = 1) {
  return groups
    .filter((group) => group.trades >= minTrades)
    .sort((a, b) => b.netPnL - a.netPnL)
    .slice(0, count);
}

function bottomGroups(groups, count = 3, minTrades = 1) {
  return groups
    .filter((group) => group.trades >= minTrades)
    .sort((a, b) => a.netPnL - b.netPnL)
    .slice(0, count);
}

function generateInsights(summary, trades) {
  const insights = [];

  if (!summary.overall.trades) {
    return ["No closed trades in this period, so there is nothing meaningful to judge yet."];
  }

  if (summary.overall.profitFactor >= 1.2) {
    insights.push("Profit factor is healthy for this sample.");
  } else if (summary.overall.profitFactor > 1) {
    insights.push("Profitability is positive, but the edge is still thin.");
  } else {
    insights.push("This period is below breakeven after losses.");
  }

  if (summary.overall.maxDrawdown > Math.abs(summary.overall.netPnL) && summary.overall.netPnL > 0) {
    insights.push("Drawdown was larger than the final net profit, so the path was choppy.");
  }

  const sideBest = topGroups(summary.bySide, 1)[0];
  const sideWorst = bottomGroups(summary.bySide, 1)[0];

  if (sideBest && sideWorst && sideBest.label !== sideWorst.label) {
    insights.push(
      `${sideBest.label} outperformed ${sideWorst.label} by ${money(
        sideBest.netPnL - sideWorst.netPnL,
      )}.`,
    );
  }

  const beCount = trades.filter((trade) => trade.closingReason === "BREAK_EVEN").length;
  if (beCount / summary.overall.trades > 0.25) {
    insights.push("Break-even exits are frequent; monitor whether BE is protecting capital or cutting winners too early.");
  }

  const weakHours = bottomGroups(summary.byHour, 2, 2);
  if (weakHours.length) {
    insights.push(
      `Weakest active hour bucket: ${weakHours
        .map((group) => `${group.label}:00 (${money(group.netPnL)})`)
        .join(", ")}.`,
    );
  }

  return insights.slice(0, 5);
}

function buildAnalytics({ trades, period, from, to, offsetMinutes = 330 }) {
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime(),
  );

  const overall = summarizeTrades(sortedTrades);
  const bySide = groupBy(sortedTrades, (trade) => trade.side);
  const byEntryReason = groupBy(sortedTrades, (trade) => trade.entryReason);
  const byReason = groupBy(sortedTrades, (trade) => trade.closingReason || trade.result);
  const byHour = groupBy(sortedTrades, (trade) => hourBucket(trade, offsetMinutes));
  const bestTrades = [...sortedTrades]
    .sort((a, b) => tradePnl(b) - tradePnl(a))
    .slice(0, 3);
  const worstTrades = [...sortedTrades]
    .sort((a, b) => tradePnl(a) - tradePnl(b))
    .slice(0, 3);

  const summary = {
    period,
    title: `${periodLabel(period)} Strategy Report`,
    range: {
      from,
      to,
      label: formatRange(from, to, offsetMinutes),
    },
    overall,
    streaks: streaks(sortedTrades),
    bySide,
    byEntryReason,
    byReason,
    byHour,
    bestTrades,
    worstTrades,
  };

  summary.insights = generateInsights(summary, sortedTrades);

  return summary;
}

function formatGroupLine(group) {
  const pf =
    group.profitFactor === Infinity ? "∞" : toNumber(group.profitFactor).toFixed(2);
  return `${group.label}: ${group.trades} trades | ${money(group.netPnL)} | WR ${pct(
    group.winRate,
  )} | PF ${pf}`;
}

function formatTradeLine(trade) {
  return `${trade.side || "?"} ${trade.tradeId || ""} ${money(tradePnl(trade))} @ ${compactPrice(
    trade.entryPrice,
  )} -> ${compactPrice(trade.exitPrice)} (${trade.closingReason || trade.result || "closed"})`;
}

function formatTelegramReport(summary, aiNarrative = null) {
  const overall = summary.overall;
  const pf =
    overall.profitFactor === Infinity ? "∞" : toNumber(overall.profitFactor).toFixed(2);
  const lines = [
    `${summary.title}`,
    summary.range.label,
    "",
    `Trades: ${overall.trades} | W/L/BE: ${overall.wins}/${overall.losses}/${overall.breakeven}`,
    `Net: ${money(overall.netPnL)} | PF: ${pf} | WR: ${pct(overall.winRate)}`,
    `Expectancy: ${money(overall.expectancy)} | Max DD: ${money(overall.maxDrawdown)}`,
    `Avg duration: ${overall.avgDurationMinutes.toFixed(1)} min | Streak W/L: ${summary.streaks.maxWin}/${summary.streaks.maxLoss}`,
    "",
    "By side:",
    ...(summary.bySide.length ? summary.bySide.map(formatGroupLine) : ["No side data"]),
    "",
    "Exit reasons:",
    ...(summary.byReason.length ? summary.byReason.map(formatGroupLine) : ["No exit data"]),
    "",
    "Entry reasons:",
    ...(summary.byEntryReason.length
      ? summary.byEntryReason.map(formatGroupLine)
      : ["No entry reason data yet"]),
    "",
    "Key observations:",
    ...summary.insights.map((insight) => `- ${insight}`),
  ];

  if (summary.worstTrades.length) {
    lines.push("", "Worst trades:", ...summary.worstTrades.map((trade) => `- ${formatTradeLine(trade)}`));
  }

  if (aiNarrative) {
    lines.push("", "AI analyst:", aiNarrative);
  }

  return lines.join("\n").slice(0, 3900);
}

module.exports = {
  buildAnalytics,
  formatTelegramReport,
  getPeriodRange,
  localDateParts,
};
