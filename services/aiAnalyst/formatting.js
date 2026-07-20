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

function shortText(value, maxLength = 88) {
  const text = compact(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizedAction(value) {
  const action = compact(value, "UNKNOWN").toUpperCase();
  return ["BUY", "SELL", "WAIT"].includes(action) ? action : "UNKNOWN";
}

function actionIcon(value) {
  return { BUY: "📈", SELL: "📉", WAIT: "⏸️" }[normalizedAction(value)] || "❔";
}

function normalizedGrade(value) {
  const grade = compact(value, "?").toUpperCase();
  return ["A", "B", "C", "D", "E", "F"].includes(grade) ? grade : "?";
}

function gradeIcon(value) {
  const grade = normalizedGrade(value);
  if (["A", "B"].includes(grade)) return "🟢";
  if (grade === "C") return "🟡";
  if (["D", "E"].includes(grade)) return "🟠";
  if (grade === "F") return "🔴";
  return "❔";
}

function confidence(value) {
  if (value == null || value === "") return "n/a";
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

function resultIcon(value) {
  return { WIN: "🟢", LOSS: "🔴", BREAKEVEN: "⚪" }[value] || "❔";
}

function primaryRisk(blind = {}) {
  return Array.isArray(blind.risks) ? blind.risks[0] : blind.risks;
}

function primaryLesson(outcome = {}) {
  return Array.isArray(outcome.lessons) ? outcome.lessons[0] : outcome.lessons;
}

function formatSignalReview({ key, blind = {}, comparison = {}, botAction = null }) {
  const bot = normalizedAction(botAction);
  const ai = normalizedAction(blind.action);
  const grade = normalizedGrade(comparison.grade);
  return [
    `🧠 <b>AI SIGNAL REVIEW</b> · <code>${escapeHtml(shortenedId(key))}</code>`,
    "",
    `🤖 <b>Bot:</b> ${escapeHtml(bot)} ${actionIcon(bot)}  |  👁 <b>AI:</b> ${escapeHtml(ai)} ${actionIcon(ai)}`,
    `${gradeIcon(grade)} <b>Grade:</b> ${escapeHtml(grade)}  |  🎯 <b>Confidence:</b> ${escapeHtml(confidence(blind.confidence))}`,
    `⚠️ <b>Risk:</b> ${escapeHtml(shortText(primaryRisk(blind)))}`,
    `💡 <b>Better:</b> ${escapeHtml(shortText(blind.bestAvailableSetup))}`,
  ].join("\n");
}

function formatOutcomeReview({ tradeId, blind = {}, comparison = {}, outcome = {}, botAction = null, finalOutcome = {} }) {
  const result = deterministicOutcome(finalOutcome);
  const bot = normalizedAction(botAction);
  const ai = normalizedAction(blind.action);
  const grade = normalizedGrade(comparison.grade);
  return [
    `📌 <b>AI OUTCOME REVIEW</b> · <code>${escapeHtml(shortenedId(tradeId))}</code>`,
    "",
    `${resultIcon(result)} <b>Result:</b> ${escapeHtml(result)}`,
    `🤖 <b>Bot:</b> ${escapeHtml(bot)} ${actionIcon(bot)}  |  👁 <b>AI:</b> ${escapeHtml(ai)} ${actionIcon(ai)}`,
    `${gradeIcon(grade)} <b>Original grade:</b> ${escapeHtml(grade)}`,
    `🧭 <b>Verdict:</b> ${escapeHtml(compact(outcome.thesisValidation).toUpperCase())}`,
    `💭 <b>Lesson:</b> ${escapeHtml(shortText(primaryLesson(outcome)))}`,
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
  actionIcon, deterministicOutcome, escapeHtml, formatAiStatus, formatOutcomeReview, formatSignalReview,
  gradeIcon, normalizedGrade, resultIcon, shortText, shortenedId,
};
