const { aiMissed, aiPeriodSummary, aiStoredStatus, aiWhy } = require("./queries");

function compact(value, fallback = "n/a") {
  if (value == null || value === "") return fallback;
  return String(value).replace(/\s+/g, " ").trim() || fallback;
}

function list(value) {
  return Array.isArray(value) && value.length ? value.map((item) => compact(item)).join("; ") : "n/a";
}

function gradeCounts(grades = {}) {
  return ["A", "B", "C", "D", "E", "F"].filter((grade) => grades[grade]).map((grade) => `${grade}:${grades[grade]}`).join(" ") || "none";
}

function formatPeriod(label, summary) {
  return [
    `AI ${label.toUpperCase()}`,
    `Runs: ${summary.runs} - succeeded: ${summary.succeeded} - failed: ${summary.failed}`,
    `Comparisons/outcomes: ${summary.comparisons}/${summary.outcomes}`,
    `Grades: ${gradeCounts(summary.grades)}`,
    `Cost: $${summary.costUsd.toFixed(4)}`,
  ].join("\n");
}

async function executeAiOwnerCommand(command, args = [], dependencies = {}) {
  const query = { aiWhy, aiMissed, aiPeriodSummary, aiStoredStatus, ...dependencies };
  if (command === "/ai_why") {
    const tradeId = args[0];
    if (!tradeId) return "Usage: /ai_why <tradeId>";
    const result = await query.aiWhy(tradeId);
    if (!result) return `No stored AI analysis found for ${tradeId}.`;
    const blind = result.blind?.assessment;
    const comparison = result.comparison?.comparison;
    const outcome = result.outcome?.review;
    return [
      `AI WHY - ${tradeId}`,
      blind ? `Blind: ${blind.action} (${blind.confidence}%) - ${compact(blind.marketState)}` : "Blind: unavailable",
      blind ? `Best setup: ${compact(blind.bestAvailableSetup)}` : null,
      blind ? `Risks: ${list(blind.risks)}` : null,
      blind ? `Confirmation: ${list(blind.requiredConfirmation)}` : null,
      comparison ? `Grade: ${comparison.grade} - ${comparison.directionAlignment}` : "Comparison: unavailable",
      comparison ? `Entry/SL/TP: ${compact(comparison.entryQuality)} | ${compact(comparison.stopLossQuality)} | ${compact(comparison.takeProfitQuality)}` : null,
      comparison ? `Difference: ${compact(comparison.differenceFromIdeal)}` : null,
      outcome ? `Outcome: ${outcome.thesisValidation} - ${compact(outcome.outcomeSummary)}` : "Outcome: open/unavailable",
      outcome ? `Lessons: ${list(outcome.lessons)}` : null,
      "Deterministic bot context:",
      result.event?.deterministicContext?.reason || result.event?.deterministicContext?.entryReason || "Not recorded",
    ].filter(Boolean).join("\n");
  }
  if (command === "/ai_missed") {
    const rows = await query.aiMissed();
    if (!rows.length) return "AI MISSED\nNo opposed or D-F comparisons stored.";
    return ["AI MISSED", ...rows.map((row) => `${row.tradeId || row.signalEventId} - ${row.comparison?.grade || "?"} - ${row.comparison?.directionAlignment || "?"}`)].join("\n");
  }
  if (command === "/ai_daily") return formatPeriod("daily", await query.aiPeriodSummary(1));
  if (command === "/ai_weekly") return formatPeriod("weekly", await query.aiPeriodSummary(7));
  if (command === "/ai_cost") {
    const summary = await query.aiPeriodSummary(1);
    return `AI COST - UTC day\nCalls: ${summary.calls}\nCost: $${summary.costUsd.toFixed(4)}`;
  }
  if (command === "/ai_status") {
    const status = await query.aiStoredStatus();
    return [
      "AI ANALYST STATUS", `Mode: ${status.mode}`,
      `Signals/controls/exits/Telegram: ${status.signalsEnabled}/${status.controlsEnabled}/${status.exitsEnabled}/${status.telegramEnabled}`,
      `Credential configured: ${status.credentialConfigured ? "yes" : "no"}`,
      `Last heartbeat: ${status.lastHeartbeatAt ? new Date(status.lastHeartbeatAt).toISOString() : "n/a"}`,
    ].join("\n");
  }
  return null;
}

module.exports = { executeAiOwnerCommand, formatPeriod, gradeCounts };
