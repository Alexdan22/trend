const test = require("node:test");
const assert = require("node:assert/strict");

const { executeAiOwnerCommand } = require("../services/aiAnalyst/telegramCommands");
const { deterministicOutcome, formatOutcomeReview, formatSignalReview } = require("../services/aiAnalyst/formatting");

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

test("automatic signal notification is compact HTML and omits deterministic score and narrative", () => {
  const message = formatSignalReview({
    key: "pair-1784304006211",
    blind: { action: "WAIT", confidence: 55, risks: ["false <break> & reversal"], bestAvailableSetup: "breakout after confirmation" },
    comparison: { grade: "D", directionAlignment: "BLIND_WAIT" },
    botAction: "SELL",
    deterministicContext: { score: 90, reason: "long pullback narrative must stay out" },
  });
  assert.equal(message.split("\n").length, 6);
  assert.ok(message.length < 600);
  assert.match(message, /^<b>AI SIGNAL<\/b>/);
  assert.match(message, /<b>Bot<\/b> SELL/);
  assert.match(message, /<b>Blind AI<\/b> WAIT/);
  assert.match(message, /<b>Grade<\/b> D/);
  assert.match(message, /<b>Confidence<\/b> 55%/);
  assert.match(message, /false &lt;break&gt; &amp; reversal/);
  assert.match(message, /…04006211/);
  assert.doesNotMatch(message, /1784304006211|Score|90|pullback narrative|marketState|directionAlignment/);
});

test("automatic outcome notification uses deterministic stored result and ignores contradictory AI wording", () => {
  const message = formatOutcomeReview({
    tradeId: "pair-1784304006211", botAction: "SELL",
    blind: { action: "WAIT", confidence: 67, risks: ["late extension"], bestAvailableSetup: "wait for a pullback" },
    comparison: { grade: "D" }, finalOutcome: { result: "BE", netPnL: 7.5 },
    outcome: { outcomeSummary: "The AI incorrectly calls this a win" },
  });
  assert.equal(message.split("\n").length, 7);
  assert.ok(message.length < 700);
  assert.match(message, /<b>Result<\/b> BREAKEVEN/);
  assert.doesNotMatch(message, /incorrectly|calls this|\bwin\b/i);
  assert.equal(deterministicOutcome({ result: "WIN", netPnL: 2 }), "WIN");
  assert.equal(deterministicOutcome({ result: "LOSS", netPnL: -2 }), "LOSS");
  assert.equal(deterministicOutcome({ netPnL: 0 }), "BREAKEVEN");
});

test("automatic AI formatters escape HTML and tolerate missing fields", () => {
  const signal = formatSignalReview({ key: "<bad&key>", blind: {}, comparison: {}, botAction: null });
  const outcome = formatOutcomeReview({ tradeId: "<bad&trade>", blind: {}, comparison: {}, finalOutcome: {} });
  for (const message of [signal, outcome]) {
    assert.doesNotMatch(message, /<bad/);
    assert.match(message, /&lt;bad&amp;/);
    assert.doesNotMatch(message, /undefined|null/);
    assert.match(message, /UNKNOWN/);
    assert.match(message, /n\/a/);
  }
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
