function compact(value, fallback = "n/a") {
  if (value == null || value === "") return fallback;
  return String(value).replace(/\s+/g, " ").trim() || fallback;
}

function escapeHtml(value) {
  return compact(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function shortenedId(value) {
  const text = compact(value);
  return text.length <= 12 ? text : `…${text.slice(-8)}`;
}

function shortText(value, maxLength = 96) {
  const text = compact(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizedAction(value) {
  const action = compact(value, "UNKNOWN").toUpperCase();
  return ["BUY", "SELL", "WAIT"].includes(action) ? action : "UNKNOWN";
}

function confidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.max(0, Math.min(100, Math.round(number)))}%` : "n/a";
}

function deterministicOutcome(finalOutcome = {}) {
  const storedResult = compact(finalOutcome.result, "").toUpperCase().replace(/[\s-]+/g, "_");
  if (["BE", "BREAKEVEN", "BREAK_EVEN"].includes(storedResult)) return "BREAKEVEN";
  if (finalOutcome.netPnL != null && finalOutcome.netPnL !== "") {
    const pnl = Number(finalOutcome.netPnL);
    if (Number.isFinite(pnl)) return pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "BREAKEVEN";
  }
  if (storedResult === "WIN") return "WIN";
  if (storedResult === "LOSS") return "LOSS";
  return "UNKNOWN";
}

function primaryRisk(blind = {}) {
  return Array.isArray(blind.risks) ? blind.risks[0] : blind.risks;
}

function formatSignalReview({ key, blind = {}, comparison = {}, botAction = null }) {
  return [
    `<b>AI SIGNAL</b> <code>${escapeHtml(shortenedId(key))}</code>`,
    "",
    `<b>Bot</b> ${escapeHtml(normalizedAction(botAction))} &#183; <b>Blind AI</b> ${escapeHtml(normalizedAction(blind.action))}`,
    `<b>Grade</b> ${escapeHtml(comparison.grade || "?")} &#183; <b>Confidence</b> ${escapeHtml(confidence(blind.confidence))}`,
    `<b>Primary risk</b> ${escapeHtml(shortText(primaryRisk(blind)))}`,
    `<b>Better setup</b> ${escapeHtml(shortText(blind.bestAvailableSetup))}`,
  ].join("\n");
}

function formatOutcomeReview({ tradeId, blind = {}, comparison = {}, botAction = null, finalOutcome = {} }) {
  return [
    `<b>AI OUTCOME</b> <code>${escapeHtml(shortenedId(tradeId))}</code>`,
    "",
    `<b>Result</b> ${escapeHtml(deterministicOutcome(finalOutcome))}`,
    `<b>Bot</b> ${escapeHtml(normalizedAction(botAction))} &#183; <b>Blind AI</b> ${escapeHtml(normalizedAction(blind.action))}`,
    `<b>Grade</b> ${escapeHtml(comparison.grade || "?")} &#183; <b>Confidence</b> ${escapeHtml(confidence(blind.confidence))}`,
    `<b>Primary risk</b> ${escapeHtml(shortText(primaryRisk(blind)))}`,
    `<b>Better setup</b> ${escapeHtml(shortText(blind.bestAvailableSetup))}`,
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

module.exports = {
  deterministicOutcome, escapeHtml, formatAiStatus, formatOutcomeReview, formatSignalReview,
  shortText, shortenedId,
};
