const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { IndependentAiMarketAnalyst } = require("../services/aiAnalyst/analyst");
const { loadAiAnalystConfig } = require("../services/aiAnalyst/config");
const { AnalysisLimiter } = require("../services/aiAnalyst/limits");
const { OpenAIStageRunner } = require("../services/aiAnalyst/openaiRunner");
const { MemoryAiAnalystRepository } = require("../services/aiAnalyst/repository");
const { BlindAssessmentSchema } = require("../services/aiAnalyst/schemas");

const BLIND = {
  marketState: "balanced range", action: "WAIT", bestAvailableSetup: "break and retest",
  idealEntryZone: { low: 1999, high: 2001, notes: "after confirmation" }, invalidation: "close below 1995",
  targets: [{ price: 2010, rationale: "range projection" }], requiredConfirmation: ["M5 close"],
  risks: ["false break"], confidence: 62, limitations: ["snapshot only"],
};
const COMPARISON = {
  directionAlignment: "BLIND_WAIT", grade: "C", entryQuality: "early", stopLossQuality: "defined",
  takeProfitQuality: "reasonable", matchedWell: ["directional location"], mayHaveMissed: ["confirmation"],
  differenceFromIdeal: "entered before confirmation", confidence: 60, limitations: ["no strategy context"],
};
const OUTCOME = {
  outcomeSummary: "trade closed at target", thesisValidation: "SUPPORTED", entryReview: "acceptable",
  managementObservations: ["partial used"], lessons: ["wait for confirmation"],
  originalGradeStillInformative: true, limitations: ["single outcome"],
};

function config(overrides = {}) {
  return Object.freeze({
    ...loadAiAnalystConfig({
      AI_ANALYST_MODE: "OBSERVE", AI_ANALYST_SIGNALS_ENABLED: "true", AI_ANALYST_CONTROLS_ENABLED: "true",
      AI_ANALYST_EXITS_ENABLED: "true", AI_ANALYST_TELEGRAM_ENABLED: "true", OPENAI_API_KEY: "test-only",
      AI_ANALYST_MAX_RPM: "60", AI_ANALYST_MAX_CALLS_PER_DAY: "100", AI_ANALYST_MAX_DAILY_COST_USD: "10",
    }),
    ...overrides,
  });
}

function fakeClient(requests, overrides = {}) {
  return { responses: { parse: async (params) => {
    requests.push(params);
    if (overrides.error) throw overrides.error;
    const system = params.input[0].content;
    const parsed = system.includes("already-persisted") ? COMPARISON : system.includes("immutable prior") ? OUTCOME : BLIND;
    return { id: `resp-${requests.length}`, output_parsed: overrides.parsed || parsed, usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 10 } }, output: [] };
  } } };
}

function seedTicks(analyst, end = Date.UTC(2026, 0, 2, 12)) {
  for (let index = 0; index < 130; index++) {
    const price = 2000 + index / 100;
    analyst.ingestTick({ timestamp: end - (129 - index) * 60_000, bid: price, ask: price + 0.2 });
  }
  return end;
}

test("signal event, blind persistence, append-only link and comparison are ordered and blind", async () => {
  const repository = new MemoryAiAnalystRepository();
  const requests = [];
  const notifications = [];
  const analyst = new IndependentAiMarketAnalyst({
    config: config(), repository, client: fakeClient(requests), notify: async (message, options) => notifications.push({ message, options }),
    chartRenderer: () => Buffer.from("png"), now: () => new Date(Date.UTC(2026, 0, 2, 12)),
  });
  const observedAt = seedTicks(analyst);
  const captured = analyst.captureSignal({
    symbol: "XAUUSDm", price: { bid: 2001, ask: 2001.2 }, sessionLabel: "LONDON_WINDOW", observedAt,
    deterministicContext: { direction: "BUY", score: 88, indicators: { rsi: 20 }, reason: "deterministic pullback" },
  });
  assert.match(captured.signalEventId, /^signal-/);
  assert.equal(analyst.recordDisposition({
    signalEventId: captured.signalEventId, disposition: "LIVE_CREATED", tradeId: "pair-1",
    actualDirection: "BUY", actualEntry: 2001.2, actualSL: 1995, actualTP: 2010, executionMode: "LIVE",
  }), true);
  await analyst.idle();

  assert.equal(repository.documents.ai_signal_events.length, 1);
  assert.equal(repository.documents.ai_market_snapshots.length, 1);
  assert.equal(repository.documents.ai_market_charts.length, 3);
  assert.equal(repository.documents.ai_blind_assessments.length, 1);
  assert.equal(repository.documents.ai_signal_trade_links.length, 1);
  assert.equal(repository.documents.ai_signal_comparisons.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "gpt-5.4-mini");
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].input[1].content.filter((item) => item.type === "input_image").length, 3);
  const blindText = requests[0].input[1].content.find((item) => item.type === "input_text").text;
  assert.doesNotMatch(blindText, /BUY|score|indicator|pullback|pair-1|tradeId|signalEventId/);
  const comparisonText = requests[1].input[1].content[0].text;
  assert.match(comparisonText, /actualDirection/);
  assert.doesNotMatch(comparisonText, /score|indicator|pullback|entryReason|category|outcome/i);
  assert.match(notifications[0].message, /<b>Bot:<\/b> BUY 📈/);
  assert.doesNotMatch(notifications[0].message, /deterministic pullback|Score|88/);
  assert.deepEqual(notifications[0].options, { parse_mode: "HTML" });
});

test("every non-trade disposition remains persisted under signalEventId", async () => {
  const repository = new MemoryAiAnalystRepository();
  const analyst = new IndependentAiMarketAnalyst({ config: config({ telegramEnabled: false }), repository, client: fakeClient([]), chartRenderer: () => Buffer.from("png") });
  seedTicks(analyst);
  for (const disposition of ["ENTRY_LOCKED", "ACCOUNT_PAUSED", "PRICE_UNAVAILABLE", "LIVE_EXECUTION_FAILED", "SHADOW_SKIPPED", "ENTRY_ERROR"]) {
    const capture = analyst.captureSignal({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionLabel: "LONDON_WINDOW" });
    analyst.recordDisposition({ signalEventId: capture.signalEventId, disposition });
  }
  await analyst.idle();
  assert.equal(repository.documents.ai_signal_events.length, 6);
  assert.deepEqual(repository.documents.ai_signal_trade_links.map((row) => row.disposition), ["ENTRY_LOCKED", "ACCOUNT_PAUSED", "PRICE_UNAVAILABLE", "LIVE_EXECUTION_FAILED", "SHADOW_SKIPPED", "ENTRY_ERROR"]);
  assert.equal(repository.documents.ai_signal_comparisons.length, 0);
});

test("a failed signal can be linked later without mutating its original event", async () => {
  const repository = new MemoryAiAnalystRepository();
  const analyst = new IndependentAiMarketAnalyst({ config: config({ telegramEnabled: false }), repository, client: fakeClient([]), chartRenderer: () => Buffer.from("png") });
  seedTicks(analyst);
  const capture = analyst.captureSignal({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionLabel: "LONDON_WINDOW", deterministicContext: { reason: "original" } });
  analyst.recordDisposition({ signalEventId: capture.signalEventId, disposition: "LIVE_EXECUTION_FAILED" });
  analyst.linkTrade({
    signalEventId: capture.signalEventId, tradeId: "pair-late", actualDirection: "BUY",
    actualEntry: 1.1, actualSL: 0.9, actualTP: 1.5, executionMode: "LIVE",
  });
  assert.equal(analyst.linkTrade({ signalEventId: capture.signalEventId, tradeId: "pair-late" }), false);
  await analyst.idle();
  assert.equal(repository.documents.ai_signal_events.length, 1);
  assert.equal(repository.documents.ai_signal_events[0].deterministicContext.reason, "original");
  assert.deepEqual(repository.documents.ai_signal_trade_links.map((row) => row.linkVersion), [1, 2]);
  assert.equal(repository.documents.ai_signal_comparisons.length, 1);
});

test("outcome is append-only and cannot revise the original grade", async () => {
  const repository = new MemoryAiAnalystRepository();
  const notifications = [];
  const analyst = new IndependentAiMarketAnalyst({ config: config(), repository, client: fakeClient([]), notify: async (message) => notifications.push(message), chartRenderer: () => Buffer.from("png") });
  const now = seedTicks(analyst);
  const capture = analyst.captureSignal({ symbol: "X", price: { bid: 2000, ask: 2000.2 }, sessionLabel: "LONDON_WINDOW", observedAt: now });
  analyst.recordDisposition({ signalEventId: capture.signalEventId, disposition: "SHADOW_CREATED", tradeId: "shadow-1", actualDirection: "SELL", actualEntry: 2000, actualSL: 2005, actualTP: 1990, executionMode: "SHADOW" });
  analyst.observeExit({
    signalEventId: capture.signalEventId, tradeId: "shadow-1", symbol: "X", price: { bid: 1990, ask: 1990.2 },
    sessionLabel: "AFTER_SESSION_CUTOFF", observedAt: now + 3_600_000,
    finalOutcome: { exitPrice: 1990, closedAt: new Date(now + 3_600_000), durationSec: 3600, closingReason: "TP_HIT", result: "WIN", netPnL: 10, realizedR: 2, partialClosed: true, breakEvenActive: true },
  });
  await analyst.idle();
  assert.equal(repository.documents.ai_outcome_reviews.length, 1);
  assert.equal(repository.documents.ai_outcome_reviews[0].originalGrade, "C");
  assert.equal(repository.documents.ai_signal_comparisons[0].comparison.grade, "C");
  assert.ok(repository.documents.ai_outcome_reviews[0].blindAssessmentHash);
  assert.ok(repository.documents.ai_outcome_reviews[0].comparisonHash);
  assert.match(notifications.at(-1), /<b>Verdict:<\/b> SUPPORTED/);
  assert.match(notifications.at(-1), /<b>Lesson:<\/b> wait for confirmation/);
  assert.doesNotMatch(notifications.at(-1), /false break|break and retest/);
});

test("capture is non-awaited and worker/API failure never touches execution", async () => {
  const repository = new MemoryAiAnalystRepository();
  let rejectApi;
  const client = { responses: { parse: () => new Promise((_, reject) => { rejectApi = reject; }) } };
  const analyst = new IndependentAiMarketAnalyst({ config: config({ telegramEnabled: false }), repository, client, chartRenderer: () => Buffer.from("png") });
  seedTicks(analyst);
  let executions = 0;
  const result = analyst.captureSignal({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionLabel: "LONDON_WINDOW" });
  executions++;
  assert.equal(executions, 1);
  assert.equal(result.queued, true);
  await new Promise((resolve) => setImmediate(resolve));
  rejectApi(new Error("outage"));
  await analyst.idle();
  assert.equal(executions, 1);
  assert.equal(repository.documents.ai_analysis_runs.at(-1).status, "API_ERROR");
});

test("timeout, refusal, invalid output and API outage become terminal diagnostics", async () => {
  for (const [label, client, expected] of [
    ["invalid", fakeClient([], { parsed: { bad: true } }), "INVALID_SCHEMA"],
    ["outage", fakeClient([], { error: new Error("offline") }), "API_ERROR"],
    ["refusal", { responses: { parse: async () => ({ output_parsed: null, output: [{ content: [{ type: "refusal", refusal: "cannot assess" }] }] }) } }, "REFUSED"],
    ["timeout", { responses: { parse: (_params, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => { const error = new Error("timeout"); error.name = "AbortError"; reject(error); })) } }, "TIMEOUT"],
  ]) {
    const repository = new MemoryAiAnalystRepository();
    const limiter = new AnalysisLimiter({ repository, maxRpm: 10, maxCallsPerDay: 10, maxDailyCostUsd: 10 });
    const runner = new OpenAIStageRunner({ client, repository, limiter, config: config({ timeoutMs: 5 }) });
    const result = await runner.run({ stage: "BLIND", signalEventId: label, payload: { safe: true }, schema: BlindAssessmentSchema, schemaName: "blind" });
    assert.equal(result.status, expected);
    assert.equal(repository.documents.ai_analysis_runs.at(-1).status, expected);
  }
});

test("OFF defaults make hooks inert and never construct an API call", async () => {
  const repository = new MemoryAiAnalystRepository();
  const analyst = new IndependentAiMarketAnalyst({ config: loadAiAnalystConfig({}), repository });
  const capture = analyst.captureSignal({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionLabel: "LONDON_WINDOW" });
  assert.equal(capture.queued, false);
  assert.equal(analyst.recordDisposition({ signalEventId: capture.signalEventId, disposition: "ENTRY_LOCKED" }), false);
  assert.equal(analyst.observeExit({ signalEventId: capture.signalEventId, tradeId: "pair", finalOutcome: {} }), false);
  await analyst.idle();
  assert.equal(repository.documents.ai_analysis_runs.length, 0);
  assert.equal(analyst.status().credentialConfigured, false);
});

test("OBSERVE without a credential records diagnostics after snapshot persistence", async () => {
  const repository = new MemoryAiAnalystRepository();
  const noKeyConfig = loadAiAnalystConfig({ AI_ANALYST_MODE: "OBSERVE", AI_ANALYST_SIGNALS_ENABLED: "true" });
  const analyst = new IndependentAiMarketAnalyst({ config: noKeyConfig, repository, chartRenderer: () => Buffer.from("png") });
  seedTicks(analyst);
  const capture = analyst.captureSignal({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionLabel: "LONDON_WINDOW" });
  assert.equal(capture.queued, true);
  await analyst.idle();
  assert.equal(repository.documents.ai_market_snapshots.length, 1);
  assert.equal(repository.documents.ai_analysis_runs.at(-1).status, "API_ERROR");
  assert.match(repository.documents.ai_analysis_runs.at(-1).failure.message, /credential not configured/);
});

test("historical warm-up requests independent M30/M5/M1 limits and respects cutoff", async () => {
  const repository = new MemoryAiAnalystRepository();
  const analyst = new IndependentAiMarketAnalyst({ config: config({ telegramEnabled: false }), repository, client: fakeClient([]), chartRenderer: () => Buffer.from("png") });
  const calls = [];
  const cutoff = new Date("2026-01-02T12:00:00Z");
  analyst.warmup(async (_symbol, timeframe, limit) => {
    calls.push([timeframe, limit]);
    const step = timeframe === "30m" ? 1_800_000 : timeframe === "5m" ? 300_000 : 60_000;
    return Array.from({ length: limit + 5 }, (_, index) => ({
      time: new Date(cutoff.getTime() - (limit + 4 - index) * step),
      open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index,
    }));
  }, "X", cutoff);
  await analyst.idle();
  assert.deepEqual(calls, [["30m", 100], ["5m", 96], ["1m", 120]]);
  assert.equal(analyst.buffer.snapshot(cutoff).m30.length, 100);
});

test("persistence failures are isolated and recorded when diagnostics storage remains available", async () => {
  class FailingRepository extends MemoryAiAnalystRepository {
    async insertSignalEvent() { throw new Error("database unavailable"); }
  }
  const repository = new FailingRepository();
  const analyst = new IndependentAiMarketAnalyst({ config: config({ telegramEnabled: false }), repository, client: fakeClient([]), chartRenderer: () => Buffer.from("png") });
  seedTicks(analyst);
  analyst.captureSignal({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionLabel: "LONDON_WINDOW" });
  await analyst.idle();
  assert.equal(repository.documents.ai_analysis_runs.at(-1).status, "PERSISTENCE_ERROR");
});

test("incomplete candle history preserves the raw snapshot and skips OpenAI", async () => {
  const repository = new MemoryAiAnalystRepository();
  const requests = [];
  const analyst = new IndependentAiMarketAnalyst({ config: config({ telegramEnabled: false }), repository, client: fakeClient(requests) });
  analyst.captureSignal({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionLabel: "LONDON_WINDOW" });
  await analyst.idle();
  assert.equal(repository.documents.ai_market_snapshots.length, 1);
  assert.equal(repository.documents.ai_market_snapshots[0].chartFailures.length, 3);
  assert.equal(repository.documents.ai_analysis_runs.at(-1).status, "INSUFFICIENT_DATA");
  assert.equal(requests.length, 0);
});

test("control snapshots are deduplicated, silent, and suppressed near signals", async () => {
  const repository = new MemoryAiAnalystRepository();
  const requests = [];
  const notifications = [];
  const base = Date.UTC(2026, 0, 2, 12);
  const analyst = new IndependentAiMarketAnalyst({ config: config(), repository, client: fakeClient(requests), notify: async (m) => notifications.push(m), chartRenderer: () => Buffer.from("png"), now: () => new Date(base) });
  const now = seedTicks(analyst);
  const sessionDecision = { allowed: true, withinWindow: true, sessionLabel: "LONDON_WINDOW" };
  const controlAt = now + 31 * 60_000;
  assert.equal(analyst.maybeCaptureControl({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionDecision, observedAt: controlAt }), true);
  assert.equal(analyst.maybeCaptureControl({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionDecision, observedAt: controlAt + 1_000 }), false);
  assert.equal(analyst.maybeCaptureControl({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionDecision: { allowed: false, withinWindow: false }, observedAt: now + 60 * 60_000 }), false);
  await analyst.idle();
  assert.equal(repository.documents.ai_signal_events.filter((row) => row.eventType === "CONTROL").length, 1);
  assert.equal(notifications.length, 0);

  const signal = analyst.captureSignal({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionLabel: "LONDON_WINDOW", observedAt: now + 60 * 60_000 });
  assert.ok(signal.signalEventId);
  assert.equal(analyst.maybeCaptureControl({ symbol: "X", price: { bid: 1, ask: 1.1 }, sessionDecision, observedAt: now + 61 * 60_000 }), false);
});

test("rate and daily limits persist through repository budgets", async () => {
  const repository = new MemoryAiAnalystRepository();
  const limiter = new AnalysisLimiter({ repository, maxRpm: 1, maxCallsPerDay: 2, maxDailyCostUsd: 0.03, now: () => new Date("2026-01-01T00:00:00Z") });
  assert.equal((await limiter.reserve(0.02)).allowed, true);
  assert.equal((await limiter.reserve(0.02)).status, "RATE_LIMITED");
  const rateRestart = new AnalysisLimiter({ repository, maxRpm: 1, maxCallsPerDay: 10, maxDailyCostUsd: 10, now: () => new Date("2026-01-01T00:00:30Z") });
  assert.equal((await rateRestart.reserve(0.001)).status, "RATE_LIMITED");
  const restarted = new AnalysisLimiter({ repository, maxRpm: 10, maxCallsPerDay: 2, maxDailyCostUsd: 0.03, now: () => new Date("2026-01-01T00:02:00Z") });
  assert.equal((await restarted.reserve(0.02)).status, "DAILY_LIMIT");
});

test("AI source tree has no execution imports or calls", () => {
  const root = path.join(__dirname, "..", "services", "aiAnalyst");
  const files = fs.readdirSync(root).filter((name) => name.endsWith(".js"));
  const forbidden = /require\([^)]*(?:exness|strategyEngine|tradeLifecycle|tradeReconciliation)|createMarket(?:Buy|Sell)Order|closePosition|safePlaceMarketOrder|processStrategyEntry/;
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, forbidden, file);
  }
  const executionSource = fs.readFileSync(path.join(__dirname, "..", "exness.js"), "utf8");
  assert.doesNotMatch(executionSource, /await\s+(?:captureAiSignal|recordAiSignalDisposition|observeAiExit|maybeCaptureAiControl|warmupAiCandles)\s*\(/);
  const replaySource = fs.readFileSync(path.join(__dirname, "..", "scripts", "replay-ai-analyst.js"), "utf8");
  assert.doesNotMatch(replaySource, /createMarket(?:Buy|Sell)Order|closePosition|deploy\s*\(|subscribeToMarketData/);
  assert.match(replaySource, /31 \* 86_400_000/);
  assert.match(replaySource, /--confirm=RUN_AI_REPLAY/);
});
