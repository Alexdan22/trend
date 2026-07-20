const test = require("node:test");
const assert = require("node:assert/strict");

const { executeAiOwnerCommand } = require("../services/aiAnalyst/telegramCommands");
const { formatSignalReview } = require("../services/aiAnalyst/formatting");

test("AI Telegram commands only read injected stored results", async () => {
  let reads = 0;
  const dependencies = {
    aiWhy: async () => { reads++; return { event: { deterministicContext: { reason: "local only" } }, blind: { assessment: { action: "WAIT", confidence: 50, marketState: "range" } }, comparison: { comparison: { grade: "C", directionAlignment: "BLIND_WAIT" } }, outcome: null }; },
    aiMissed: async () => [],
    aiPeriodSummary: async (days) => ({ days, runs: 2, succeeded: 2, failed: 0, comparisons: 1, outcomes: 1, costUsd: 0.0123, calls: 2, grades: { C: 1 } }),
    aiStoredStatus: async () => ({ mode: "OFF", signalsEnabled: false, controlsEnabled: false, exitsEnabled: false, telegramEnabled: false, lastHeartbeatAt: null }),
  };
  assert.match(await executeAiOwnerCommand("/ai_why", ["pair-1"], dependencies), /local only/);
  assert.match(await executeAiOwnerCommand("/ai_daily", [], dependencies), /Cost: \$0\.0123/);
  assert.match(await executeAiOwnerCommand("/ai_weekly", [], dependencies), /AI WEEKLY/);
  assert.match(await executeAiOwnerCommand("/ai_cost", [], dependencies), /Calls: 2/);
  assert.match(await executeAiOwnerCommand("/ai_status", [], dependencies), /Mode: OFF/);
  assert.match(await executeAiOwnerCommand("/ai_missed", [], dependencies), /No opposed/);
  assert.equal(reads, 1);
});

test("signal formatting separates AI assessment from deterministic reasoning", () => {
  const message = formatSignalReview({
    key: "signal-1",
    blind: { action: "WAIT", confidence: 55, marketState: "range", bestAvailableSetup: "breakout" },
    comparison: { grade: "D", directionAlignment: "BLIND_WAIT" },
    deterministicContext: { score: 90, reason: "pullback" },
  });
  assert.match(message, /Blind: WAIT/);
  assert.match(message, /Deterministic bot context \(not sent to AI\):/);
  assert.match(message, /Score: 90 · pullback/);
});

test("control snapshots have no formatter or command that sends a notification", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "services", "aiAnalyst", "analyst.js"), "utf8");
  const controlBlock = source.slice(source.indexOf("maybeCaptureControl"), source.indexOf("async #captureAndBlind"));
  assert.doesNotMatch(controlBlock, /#notify\(/);
});

test("AI commands remain behind the existing owner authorization guard", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "telegram.js"), "utf8");
  const handler = source.slice(source.indexOf("async function handleOwnerCommand"), source.indexOf("async function initTelegramBot"));
  assert.ok(handler.indexOf("isAuthorizedCommandUser") < handler.indexOf('case "/ai_why"'));
});
