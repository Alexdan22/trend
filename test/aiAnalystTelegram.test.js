const test = require("node:test");
const assert = require("node:assert/strict");

const { executeAiOwnerCommand } = require("../services/aiAnalyst/telegramCommands");
const {
  actionIcon, deterministicOutcome, formatOutcomeReview, formatSignalReview, gradeIcon, resultIcon,
} = require("../services/aiAnalyst/formatting");

test("AI Telegram commands only read injected stored results and preserve detailed /ai_why output", async () => {
  let reads = 0;
  const dependencies = {
    aiWhy: async () => {
      reads++;
      return {
        event: { deterministicContext: { reason: "local only" } },
        blind: { assessment: {
          action: "WAIT", confidence: 50, marketState: "range", bestAvailableSetup: "break and retest",
          risks: ["false break"], requiredConfirmation: ["M5 close"],
        } },
        comparison: { comparison: {
          grade: "C", directionAlignment: "BLIND_WAIT", entryQuality: "early",
          stopLossQuality: "defined", takeProfitQuality: "reasonable", differenceFromIdeal: "wait",
        } },
        outcome: null,
      };
    },
    aiMissed: async () => [],
    aiPeriodSummary: async (days) => ({ days, runs: 2, succeeded: 2, failed: 0, comparisons: 1, outcomes: 1, costUsd: 0.0123, calls: 2, grades: { C: 1 } }),
    aiStoredStatus: async () => ({ mode: "OFF", signalsEnabled: false, controlsEnabled: false, exitsEnabled: false, telegramEnabled: false, lastHeartbeatAt: null }),
  };
  const why = await executeAiOwnerCommand("/ai_why", ["pair-1"], dependencies);
  assert.match(why, /local only/);
  assert.match(why, /Best setup: break and retest/);
  assert.match(why, /Risks: false break/);
  assert.match(await executeAiOwnerCommand("/ai_daily", [], dependencies), /Cost: \$0\.0123/);
  assert.match(await executeAiOwnerCommand("/ai_weekly", [], dependencies), /AI WEEKLY/);
  assert.match(await executeAiOwnerCommand("/ai_cost", [], dependencies), /Calls: 2/);
  assert.match(await executeAiOwnerCommand("/ai_status", [], dependencies), /Mode: OFF/);
  assert.match(await executeAiOwnerCommand("/ai_missed", [], dependencies), /No opposed/);
  assert.equal(reads, 1);
});

test("signal notification matches the compact semantic HTML snapshot", () => {
  const message = formatSignalReview({
    key: "pair-1784304006211",
    blind: { action: "BUY", confidence: 66, risks: ["Near <resistance> & rejection"], bestAvailableSetup: "Wait for a pullback into 4012–4014" },
    comparison: { grade: "F", directionAlignment: "OPPOSED" },
    botAction: "SELL",
    deterministicContext: { score: 90, reason: "long pullback narrative must stay out" },
  });
  assert.equal(message, [
    "🧠 <b>AI SIGNAL REVIEW</b> · <code>…04006211</code>",
    "",
    "🤖 <b>Bot:</b> SELL 📉  |  👁 <b>AI:</b> BUY 📈",
    "🔴 <b>Grade:</b> F  |  🎯 <b>Confidence:</b> 66%",
    "⚠️ <b>Risk:</b> Near &lt;resistance&gt; &amp; rejection",
    "💡 <b>Better:</b> Wait for a pullback into 4012–4014",
  ].join("\n"));
  assert.doesNotMatch(message, /1784304006211|Score|90|pullback narrative|marketState|directionAlignment/);
});

test("outcome notification matches the compact semantic HTML snapshot", () => {
  const message = formatOutcomeReview({
    tradeId: "pair-1784304006211", botAction: "SELL",
    blind: { action: "WAIT", confidence: 67, risks: ["late extension"], bestAvailableSetup: "wait for a pullback" },
    comparison: { grade: "D" }, finalOutcome: { result: "BE", netPnL: 7.5 },
    outcome: {
      thesisValidation: "INCONCLUSIVE",
      lessons: ["Outcome did not validate the original setup"],
      outcomeSummary: "The AI incorrectly calls this a win",
    },
  });
  assert.equal(message, [
    "📌 <b>AI OUTCOME REVIEW</b> · <code>…04006211</code>",
    "",
    "⚪ <b>Result:</b> BREAKEVEN",
    "🤖 <b>Bot:</b> SELL 📉  |  👁 <b>AI:</b> WAIT ⏸️",
    "🟠 <b>Original grade:</b> D",
    "🧭 <b>Verdict:</b> INCONCLUSIVE",
    "💭 <b>Lesson:</b> Outcome did not validate the original setup",
  ].join("\n"));
  assert.doesNotMatch(message, /late extension|wait for a pullback|incorrectly|calls this|\bwin\b/i);
  assert.equal(deterministicOutcome({ result: "WIN", netPnL: 2 }), "WIN");
  assert.equal(deterministicOutcome({ result: "LOSS", netPnL: -2 }), "LOSS");
  assert.equal(deterministicOutcome({ netPnL: 0 }), "BREAKEVEN");
});

test("direction, result, and every grade band have stable semantic icon snapshots", () => {
  assert.deepEqual(Object.fromEntries(["BUY", "SELL", "WAIT"].map((action) => [action, actionIcon(action)])), {
    BUY: "📈", SELL: "📉", WAIT: "⏸️",
  });
  assert.deepEqual(Object.fromEntries(["WIN", "LOSS", "BREAKEVEN"].map((result) => [result, resultIcon(result)])), {
    WIN: "🟢", LOSS: "🔴", BREAKEVEN: "⚪",
  });
  assert.deepEqual(Object.fromEntries(["A", "B", "C", "D", "E", "F"].map((grade) => [grade, gradeIcon(grade)])), {
    A: "🟢", B: "🟢", C: "🟡", D: "🟠", E: "🟠", F: "🔴",
  });
});

test("automatic AI formatters escape HTML and have stable missing-field snapshots", () => {
  const signal = formatSignalReview({ key: "<bad&key>", blind: {}, comparison: {}, botAction: null });
  const outcome = formatOutcomeReview({ tradeId: "<bad&trade>", blind: {}, comparison: {}, finalOutcome: {} });
  assert.equal(signal, [
    "🧠 <b>AI SIGNAL REVIEW</b> · <code>&lt;bad&amp;key&gt;</code>",
    "",
    "🤖 <b>Bot:</b> UNKNOWN ❔  |  👁 <b>AI:</b> UNKNOWN ❔",
    "❔ <b>Grade:</b> ?  |  🎯 <b>Confidence:</b> n/a",
    "⚠️ <b>Risk:</b> n/a",
    "💡 <b>Better:</b> n/a",
  ].join("\n"));
  assert.equal(outcome, [
    "📌 <b>AI OUTCOME REVIEW</b> · <code>&lt;bad&amp;trade&gt;</code>",
    "",
    "❔ <b>Result:</b> UNKNOWN",
    "🤖 <b>Bot:</b> UNKNOWN ❔  |  👁 <b>AI:</b> UNKNOWN ❔",
    "❔ <b>Original grade:</b> ?",
    "🧭 <b>Verdict:</b> N/A",
    "💭 <b>Lesson:</b> n/a",
  ].join("\n"));
});

test("automatic notifications retain six/seven lines and stay below prior and Telegram limits", () => {
  const long = `<unsafe&>${"x".repeat(5_000)}`;
  const signal = formatSignalReview({
    key: long, botAction: "BUY",
    blind: { action: "SELL", confidence: 100, risks: [long], bestAvailableSetup: long },
    comparison: { grade: "A" },
  });
  const outcome = formatOutcomeReview({
    tradeId: long, botAction: "WAIT", blind: { action: "BUY" }, comparison: { grade: "C" },
    outcome: { thesisValidation: "SUPPORTED", lessons: [long] }, finalOutcome: { result: "LOSS" },
  });
  assert.equal(signal.split("\n").length, 6);
  assert.equal(outcome.split("\n").length, 7);
  assert.ok(signal.length < 600 && signal.length < 4_096);
  assert.ok(outcome.length < 700 && outcome.length < 4_096);
  assert.doesNotMatch(signal, /<unsafe/);
  assert.doesNotMatch(outcome, /<unsafe/);
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
