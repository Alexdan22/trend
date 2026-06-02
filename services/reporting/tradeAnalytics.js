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

function signedMoney(value) {
  const number = toNumber(value);
  const sign = number > 0 ? "+" : number < 0 ? "-" : "";
  return `${sign}$${Math.abs(number).toFixed(2)}`;
}

function compactPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "N/A";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlBold(value) {
  return `<b>${escapeHtml(value)}</b>`;
}

function htmlCode(value) {
  return `<code>${escapeHtml(value)}</code>`;
}

function pad(value, width, align = "left") {
  const text = String(value ?? "");
  if (text.length >= width) return text.slice(0, width);
  const padding = " ".repeat(width - text.length);
  return align === "right" ? `${padding}${text}` : `${text}${padding}`;
}

function formatProfitFactor(value) {
  return value === Infinity ? "INF" : toNumber(value).toFixed(2);
}

function verdict(summary) {
  const overall = summary.overall;

  if (!overall.trades) return "QUIET SESSION";
  if (overall.netPnL > 0 && overall.profitFactor >= 1.4) return "EDGE HOLDING";
  if (overall.netPnL > 0) return "POSITIVE, THIN EDGE";
  if (overall.netPnL < 0 && overall.profitFactor < 0.8) return "DEFENSIVE REVIEW";
  if (overall.netPnL < 0) return "SLIGHTLY NEGATIVE";
  return "FLAT";
}

function riskTone(summary) {
  const overall = summary.overall;

  if (!overall.trades) return "No closed-trade sample yet.";
  if (overall.maxDrawdown > Math.abs(overall.netPnL) && overall.netPnL > 0) {
    return "Profit came with a choppy equity path.";
  }
  if (overall.profitFactor >= 1.4 && overall.expectancy > 0) {
    return "Quality looks constructive for this sample.";
  }
  if (overall.profitFactor < 1) return "Losses outweighed winners this period.";
  return "Edge is present but needs more separation.";
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

function formatGroupTableRich(groups, emptyText = "No data yet") {
  if (!groups.length) return [escapeHtml(emptyText)];

  const rows = [
    `${pad("Bucket", 14)} ${pad("Trd", 3, "right")} ${pad("Net", 10, "right")} ${pad("WR", 6, "right")} ${pad("PF", 5, "right")}`,
    `${pad("--------------", 14)} ${pad("---", 3)} ${pad("----------", 10)} ${pad("------", 6)} ${pad("-----", 5)}`,
  ];

  for (const group of groups.slice(0, 6)) {
    rows.push(
      `${pad(group.label, 14)} ${pad(group.trades, 3, "right")} ${pad(
        signedMoney(group.netPnL),
        10,
        "right",
      )} ${pad(pct(group.winRate), 6, "right")} ${pad(
        formatProfitFactor(group.profitFactor),
        5,
        "right",
      )}`,
    );
  }

  return rows.map(htmlCode);
}

function shortTradeId(trade) {
  const id = trade.tradeId || trade.pairId || "";
  return String(id).slice(-8) || "trade";
}

function formatTradeLineRich(trade) {
  return htmlCode(
    `${pad(trade.side || "?", 4)} ${pad(signedMoney(tradePnl(trade)), 10, "right")} ${pad(
      compactPrice(trade.entryPrice),
      8,
      "right",
    )} -> ${pad(compactPrice(trade.exitPrice), 8, "right")} ${pad(
      trade.closingReason || trade.result || "closed",
      14,
    )} ${shortTradeId(trade)}`,
  );
}

function formatObservationsRich(summary) {
  if (!summary.insights.length) return ["- No observations yet."];
  return summary.insights.map((insight) => `- ${escapeHtml(insight)}`);
}

function fitTelegramLines(lines, limit = 3900) {
  const output = [];
  let length = 0;

  for (const line of lines) {
    const nextLength = length + line.length + 1;
    if (nextLength > limit) {
      output.push(escapeHtml("... report trimmed to fit Telegram message limit"));
      break;
    }

    output.push(line);
    length = nextLength;
  }

  return output.join("\n");
}

function formatTelegramReportV2(summary, aiNarrative = null) {
  const overall = summary.overall;
  const topHours = topGroups(summary.byHour, 2, 1);
  const weakHours = bottomGroups(summary.byHour, 2, 1);
  const topEntries = topGroups(summary.byEntryReason, 4, 1);
  const exitReasons = topGroups(summary.byReason, 6, 1);

  const lines = [
    htmlBold(`Pullback Engine - ${summary.title}`),
    htmlCode(summary.range.label),
    "",
    htmlBold("EXECUTIVE READ"),
    `Verdict: ${htmlBold(verdict(summary))}`,
    `Risk note: ${escapeHtml(riskTone(summary))}`,
    "",
    htmlBold("SCORECARD"),
    `${pad("Trades", 13)} ${htmlBold(overall.trades)}`,
    `${pad("W / L / BE", 13)} ${htmlBold(
      `${overall.wins} / ${overall.losses} / ${overall.breakeven}`,
    )}`,
    `${pad("Net PnL", 13)} ${htmlBold(signedMoney(overall.netPnL))}`,
    `${pad("Win Rate", 13)} ${htmlBold(pct(overall.winRate))}`,
    `${pad("Profit F.", 13)} ${htmlBold(formatProfitFactor(overall.profitFactor))}`,
    `${pad("Expectancy", 13)} ${htmlBold(`${signedMoney(overall.expectancy)} / trade`)}`,
    `${pad("Max DD", 13)} ${htmlBold(money(overall.maxDrawdown))}`,
    `${pad("Avg Hold", 13)} ${htmlBold(`${overall.avgDurationMinutes.toFixed(1)} min`)}`,
    `${pad("Streak W/L", 13)} ${htmlBold(
      `${summary.streaks.maxWin} / ${summary.streaks.maxLoss}`,
    )}`,
    "",
    htmlBold("SIDE PERFORMANCE"),
    ...formatGroupTableRich(summary.bySide, "No side data"),
    "",
    htmlBold("EXIT QUALITY"),
    ...formatGroupTableRich(exitReasons, "No exit data"),
    "",
    htmlBold("ENTRY PATTERNS"),
    ...formatGroupTableRich(topEntries, "No entry reason data yet"),
    "",
    htmlBold("TIME WINDOWS"),
    `Best: ${
      topHours.length
        ? topHours.map((group) => `${escapeHtml(group.label)}:00 ${signedMoney(group.netPnL)}`).join(", ")
        : "No active window yet"
    }`,
    `Weak: ${
      weakHours.length
        ? weakHours.map((group) => `${escapeHtml(group.label)}:00 ${signedMoney(group.netPnL)}`).join(", ")
        : "No weak window yet"
    }`,
    "",
    htmlBold("OBSERVATIONS"),
    ...formatObservationsRich(summary),
  ];

  if (summary.bestTrades.length || summary.worstTrades.length) {
    lines.push("", htmlBold("TRADE SPOTLIGHT"));

    if (summary.bestTrades.length) {
      lines.push("Best:", ...summary.bestTrades.map(formatTradeLineRich));
    }

    if (summary.worstTrades.length) {
      lines.push("Worst:", ...summary.worstTrades.map(formatTradeLineRich));
    }
  }

  if (aiNarrative) {
    lines.push("", htmlBold("AI ANALYST"), escapeHtml(aiNarrative));
  }

  return fitTelegramLines(lines);
}

module.exports = {
  buildAnalytics,
  formatTelegramReport: formatTelegramReportV2,
  getPeriodRange,
  localDateParts,
};
