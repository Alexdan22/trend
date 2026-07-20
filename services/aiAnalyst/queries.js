const { loadAiAnalystConfig } = require("./config");

function defaultDb() { return require("../../db").getDB(); }

async function aiWhy(tradeId, getDb = defaultDb) {
  const db = getDb();
  const link = await db.collection("ai_signal_trade_links").findOne({ tradeId }, { sort: { createdAt: -1 } });
  if (!link) return null;
  const [event, blind, comparison, outcome] = await Promise.all([
    db.collection("ai_signal_events").findOne({ signalEventId: link.signalEventId }),
    db.collection("ai_blind_assessments").findOne({ signalEventId: link.signalEventId }, { sort: { createdAt: -1 } }),
    db.collection("ai_signal_comparisons").findOne({ signalEventId: link.signalEventId }, { sort: { createdAt: -1 } }),
    db.collection("ai_outcome_reviews").findOne({ tradeId }, { sort: { createdAt: -1 } }),
  ]);
  return { link, event, blind, comparison, outcome };
}

function periodStart(days, now = new Date()) { return new Date(now.getTime() - days * 86_400_000); }

async function aiPeriodSummary(days, getDb = defaultDb, now = new Date()) {
  const from = periodStart(days, now);
  const db = getDb();
  const [runs, comparisons, outcomes] = await Promise.all([
    db.collection("ai_analysis_runs").find({ createdAt: { $gte: from } }).toArray(),
    db.collection("ai_signal_comparisons").find({ createdAt: { $gte: from } }).toArray(),
    db.collection("ai_outcome_reviews").find({ createdAt: { $gte: from } }).toArray(),
  ]);
  const succeeded = runs.filter((run) => run.status === "SUCCEEDED");
  return {
    days, from, runs: runs.length, succeeded: succeeded.length,
    failed: runs.length - succeeded.length, comparisons: comparisons.length, outcomes: outcomes.length,
    costUsd: runs.reduce((sum, run) => sum + Number(run.costUsd || 0), 0),
    calls: new Set(runs.filter((run) => run.status !== "PREREQUISITE_MISSING").map((run) => run.runId)).size,
    grades: comparisons.reduce((counts, row) => { const grade = row.comparison?.grade || "?"; counts[grade] = (counts[grade] || 0) + 1; return counts; }, {}),
  };
}

async function aiMissed(getDb = defaultDb) {
  const db = getDb();
  return db.collection("ai_signal_comparisons").find({
    $or: [
      { "comparison.directionAlignment": "OPPOSED" },
      { "comparison.grade": { $in: ["D", "E", "F"] } },
    ],
  }).sort({ createdAt: -1 }).limit(10).toArray();
}

async function aiStoredStatus(getDb = defaultDb) {
  const config = loadAiAnalystConfig();
  const runtime = await getDb().collection("ai_analyst_runtime").findOne({ runtimeKey: "singleton" });
  return {
    mode: config.mode, signalsEnabled: config.signalsEnabled, controlsEnabled: config.controlsEnabled,
    exitsEnabled: config.exitsEnabled, telegramEnabled: config.telegramEnabled,
    credentialConfigured: Boolean(config.apiKey),
    lastHeartbeatAt: runtime?.heartbeatAt || runtime?.updatedAt || null,
  };
}

module.exports = { aiMissed, aiPeriodSummary, aiStoredStatus, aiWhy, periodStart };
