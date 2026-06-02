const axios = require("axios");

function aiEnabled() {
  return (
    process.env.AI_REPORTS_ENABLED === "true" &&
    Boolean(process.env.OPENAI_API_KEY)
  );
}

function compactSummary(summary) {
  return {
    period: summary.period,
    range: summary.range.label,
    overall: summary.overall,
    streaks: summary.streaks,
    bySide: summary.bySide,
    byEntryReason: summary.byEntryReason,
    byReason: summary.byReason,
    insights: summary.insights,
    worstTrades: summary.worstTrades.map((trade) => ({
      tradeId: trade.tradeId,
      side: trade.side,
      pnl: trade.netPnL ?? trade.grossPnL,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      closingReason: trade.closingReason,
      durationSec: trade.durationSec,
    })),
  };
}

async function generateAiNarrative(summary) {
  if (!aiEnabled()) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const payload = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a concise trading-system analyst. Analyze only the supplied trade statistics. Do not invent data. Be practical, skeptical, and focused on improving monitoring.",
      },
      {
        role: "user",
        content:
          "Write a short Telegram-ready analyst note with: 1) what worked, 2) what hurt performance, 3) what to monitor next. Keep it under 120 words.\n\n" +
          JSON.stringify(compactSummary(summary)),
      },
    ],
    temperature: 0.2,
    max_tokens: 220,
  };

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      {
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    return response.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn("[AI REPORT] Narrative failed:", err.message || err);
    return null;
  }
}

module.exports = {
  generateAiNarrative,
};
