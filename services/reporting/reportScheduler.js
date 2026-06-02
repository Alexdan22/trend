const { localDateParts } = require("./tradeAnalytics");

const DEFAULTS = {
  dailyTime: "23:55",
  weeklyTime: "23:57",
  monthlyTime: "23:59",
  weeklyDay: 0,
};

function parseTime(text, fallback) {
  const value = String(text || fallback);
  const match = value.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) return parseTime(fallback, "23:55");

  return {
    hour: Math.max(0, Math.min(23, Number(match[1]))),
    minute: Math.max(0, Math.min(59, Number(match[2]))),
    text: `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`,
  };
}

function reportOffsetMinutes() {
  const value = Number(process.env.REPORT_TZ_OFFSET_MINUTES);
  return Number.isFinite(value) ? value : 330;
}

function localDateKey(parts) {
  return [
    parts.year,
    String(parts.month + 1).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function weekKey(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month, parts.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monthKey(parts) {
  return `${parts.year}-${String(parts.month + 1).padStart(2, "0")}`;
}

function matchesTime(parts, schedule) {
  return parts.hour === schedule.hour && parts.minute === schedule.minute;
}

function getDueReports(now = new Date()) {
  const offsetMinutes = reportOffsetMinutes();
  const parts = localDateParts(now, offsetMinutes);
  const daily = parseTime(process.env.REPORT_DAILY_TIME, DEFAULTS.dailyTime);
  const weekly = parseTime(process.env.REPORT_WEEKLY_TIME, DEFAULTS.weeklyTime);
  const monthly = parseTime(process.env.REPORT_MONTHLY_TIME, DEFAULTS.monthlyTime);
  const weeklyDay = Number.isFinite(Number(process.env.REPORT_WEEKLY_DAY))
    ? Number(process.env.REPORT_WEEKLY_DAY)
    : DEFAULTS.weeklyDay;

  const due = [];

  if (matchesTime(parts, daily)) {
    due.push({
      period: "daily",
      key: `daily:${localDateKey(parts)}`,
    });
  }

  if (parts.dayOfWeek === weeklyDay && matchesTime(parts, weekly)) {
    due.push({
      period: "weekly",
      key: `weekly:${weekKey(parts)}`,
    });
  }

  if (parts.day === parts.lastDayOfMonth && matchesTime(parts, monthly)) {
    due.push({
      period: "monthly",
      key: `monthly:${monthKey(parts)}`,
    });
  }

  return due;
}

function splitTelegramMessage(message, limit = 3900) {
  if (message.length <= limit) return [message];

  const chunks = [];
  let remaining = message;

  while (remaining.length > limit) {
    const index = remaining.lastIndexOf("\n", limit);
    const splitAt = index > 1000 ? index : limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendReport(period, sendTelegram, now = new Date()) {
  const { buildTradeReport } = require("./reportBuilder");
  const { message } = await buildTradeReport(period, now);
  const chatId = process.env.TELEGRAM_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

  for (const chunk of splitTelegramMessage(message)) {
    await sendTelegram(chunk, chatId ? { chatId } : {});
  }
}

function startReportScheduler({ sendTelegram }) {
  if (process.env.REPORTS_ENABLED === "false") {
    console.log("[REPORTS] Scheduler disabled");
    return null;
  }

  if (typeof sendTelegram !== "function") {
    throw new Error("sendTelegram function is required for report scheduler");
  }

  const tick = async () => {
    try {
      for (const due of getDueReports()) {
        const { acquireReportRun } = require("../../models");
        const acquired = await acquireReportRun(due.key, due.period);
        if (!acquired) continue;

        console.log(`[REPORTS] Sending ${due.period} report (${due.key})`);
        await sendReport(due.period, sendTelegram);
      }
    } catch (err) {
      console.error("[REPORTS] Scheduler tick failed:", err.message || err);
    }
  };

  const interval = setInterval(tick, 60 * 1000);
  setTimeout(tick, 5000);

  console.log("[REPORTS] Scheduler started");
  return interval;
}

module.exports = {
  getDueReports,
  sendReport,
  startReportScheduler,
};
