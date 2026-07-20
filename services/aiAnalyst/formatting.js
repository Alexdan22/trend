function compact(value, fallback = "n/a") {
  if (value == null || value === "") return fallback;
  return String(value).replace(/\s+/g, " ").trim();
}

function formatSignalReview({ key, blind, comparison, deterministicContext }) {
  const reasoning = deterministicContext?.reason || deterministicContext?.entryReason || "Not recorded";
  const score = deterministicContext?.score == null ? "n/a" : deterministicContext.score;
  return [
    `AI OBSERVATION · ${compact(key)}`,
    `Blind: ${blind.action} (${blind.confidence}%) · ${compact(blind.marketState)}`,
    `Grade: ${comparison.grade} · ${comparison.directionAlignment}`,
    `Ideal: ${compact(blind.bestAvailableSetup)}`,
    "",
    "Deterministic bot context (not sent to AI):",
    `Score: ${score} · ${compact(reasoning)}`,
  ].join("\n");
}

function formatOutcomeReview({ tradeId, outcome }) {
  return [
    `AI OUTCOME REVIEW · ${compact(tradeId)}`,
    `${outcome.thesisValidation} · ${compact(outcome.outcomeSummary)}`,
    `Original grade retained: ${outcome.originalGradeStillInformative ? "yes" : "no"}`,
  ].join("\n");
}

function formatAiStatus(status) {
  return [
    "AI ANALYST STATUS",
    `Mode: ${status.mode}`,
    `Signals/controls/exits: ${status.signalsEnabled}/${status.controlsEnabled}/${status.exitsEnabled}`,
    `Queue: ${status.queueSize}`,
    `Last heartbeat: ${status.lastHeartbeatAt || "n/a"}`,
  ].join("\n");
}

module.exports = { formatAiStatus, formatOutcomeReview, formatSignalReview };
