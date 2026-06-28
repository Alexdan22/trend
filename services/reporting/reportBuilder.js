const { getShadowTradesAll, getTradesAll } = require("../../models");
const {
  buildAnalytics,
  formatTelegramReport,
  getPeriodRange,
} = require("./tradeAnalytics");
const { generateAiNarrative } = require("./aiNarrator");
const { sessionWindowLabel } = require("../sessionWindow");

function reportOffsetMinutes() {
  const value = Number(process.env.REPORT_TZ_OFFSET_MINUTES);
  return Number.isFinite(value) ? value : 330;
}

async function buildTradeReport(period, now = new Date()) {
  const offsetMinutes = reportOffsetMinutes();
  const { from, to } = getPeriodRange(period, now, offsetMinutes);
  const trades = await getTradesAll(from, to);
  const shadowTrades = await getShadowTradesAll(from, to);
  const summary = buildAnalytics({
    trades,
    period,
    from,
    to,
    offsetMinutes,
  });
  const shadowSummary = buildAnalytics({
    trades: shadowTrades,
    period: `${period}-shadow`,
    from,
    to,
    offsetMinutes,
  });
  const aiNarrative = await generateAiNarrative(summary);

  return {
    summary,
    shadowSummary,
    message: formatTelegramReport(summary, aiNarrative, {
      shadowSummary,
      sessionWindow: sessionWindowLabel(),
    }),
    options: {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
  };
}

module.exports = {
  buildTradeReport,
  reportOffsetMinutes,
};
