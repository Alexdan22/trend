const test = require("node:test");
const assert = require("node:assert/strict");

const { IndependentCandleBuffer, sanitizeProviderCandle } = require("../services/aiAnalyst/candles");
const { renderCleanCandlestickChart, WIDTH, HEIGHT } = require("../services/aiAnalyst/chartRenderer");
const { buildBlindPayload, buildComparisonPayload, buildOutcomePayload } = require("../services/aiAnalyst/payloads");
const { BlindAssessmentSchema, OutcomeReviewSchema, SignalComparisonSchema } = require("../services/aiAnalyst/schemas");
const { withCanonicalHash } = require("../services/aiAnalyst/canonical");
const { Binary } = require("mongodb");

function candles(count, stepMs, end = Date.UTC(2026, 0, 2)) {
  return Array.from({ length: count }, (_, index) => {
    const close = 2000 + index / 10;
    return { time: new Date(end - (count - index) * stepMs), open: close - 0.1, high: close + 0.3, low: close - 0.3, close, tickVolume: 999 };
  });
}

test("blind and comparison payloads have independent exact allowlists", () => {
  const blind = buildBlindPayload({
    correlationId: "random", timestamp: "2026-01-01T00:00:00.000Z", symbol: "XAUUSDm",
    bid: 2000, ask: 2000.2, spread: 0.2, sessionLabel: "LONDON_WINDOW",
    candles: { m30: [], m5: [], m1: [] }, charts: {},
  });
  assert.deepEqual(Object.keys(blind).sort(), ["ask", "bid", "candles", "charts", "correlationId", "sessionLabel", "spread", "symbol", "timestamp"]);
  assert.throws(() => buildBlindPayload({ ...blind, direction: "BUY" }), /not permitted/);
  assert.throws(() => buildBlindPayload({ ...blind, tradeId: "pair-secret" }), /not permitted/);

  const comparison = buildComparisonPayload({
    blindAssessment: { action: "WAIT" }, actualDirection: "BUY", actualEntry: 2000,
    actualSL: 1995, actualTP: 2010, executionMode: "LIVE",
  });
  assert.equal(comparison.executionMode, "LIVE");
  assert.throws(() => buildComparisonPayload({ ...comparison, score: 90 }), /not permitted/);
  assert.throws(() => buildComparisonPayload({ ...comparison, indicators: { rsi: 20 } }), /not permitted/);
  assert.throws(() => buildComparisonPayload({ ...comparison, strategyReasoning: "pullback" }), /not permitted/);
});

test("shared privacy guard rejects credentials and account/broker identifiers at every stage", () => {
  assert.throws(() => buildComparisonPayload({
    blindAssessment: { action: "WAIT", notes: ["sk", "examplecredential12345"].join("-") },
    actualDirection: "BUY", actualEntry: 1, actualSL: 0.9, actualTP: 1.2, executionMode: "LIVE",
  }), /credential-like/);
  assert.throws(() => buildOutcomePayload({
    blindAssessment: { action: "BUY" }, comparison: { grade: "A" },
    finalOutcome: { exitPrice: 1, accountId: "redact-me" },
  }), /not permitted/);
});

test("candles store OHLC only unless explicit realVolume exists", () => {
  const noRealVolume = sanitizeProviderCandle({
    time: "2026-01-01T00:00:00Z", open: 1, high: 2, low: 0.5, close: 1.5,
    tickVolume: 123, volume: 456,
  }, Date.UTC(2026, 0, 2));
  assert.deepEqual(Object.keys(noRealVolume), ["timestamp", "open", "high", "low", "close"]);

  const real = sanitizeProviderCandle({
    time: "2026-01-01T00:00:00Z", open: 1, high: 2, low: 0.5, close: 1.5, realVolume: 7,
  }, Date.UTC(2026, 0, 2));
  assert.equal(real.volume, 7);
  assert.equal(real.volumeProvenance, "UPSTREAM_REAL_VOLUME");
});

test("history is cutoff-safe and M30 is bounded to exactly 100", () => {
  const buffer = new IndependentCandleBuffer({ m1: 120, m5: 96, m30: 100 });
  const cutoff = Date.UTC(2026, 0, 2);
  const history = candles(120, 1_800_000, cutoff);
  history.push({ time: new Date(cutoff + 1), open: 1, high: 2, low: 0.5, close: 1 });
  buffer.loadHistory("m30", history, cutoff);
  const snapshot = buffer.snapshot(cutoff);
  assert.equal(snapshot.m30.length, 100);
  assert.ok(snapshot.m30.every((candle) => candle.timestamp <= cutoff));
  assert.ok(snapshot.m30.every((candle) => !("volume" in candle)));
});

test("clean chart renderer produces a 1024x576 PNG without trade inputs", () => {
  const rows = candles(20, 60_000).map((candle) => sanitizeProviderCandle(candle, Date.UTC(2026, 0, 3)));
  const png = renderCleanCandlestickChart(rows, "m1");
  assert.equal(WIDTH, 1024);
  assert.equal(HEIGHT, 576);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(renderCleanCandlestickChart.length, 2);
});

test("strict schemas reject added or malformed output fields", () => {
  const blind = {
    marketState: "range", action: "WAIT", bestAvailableSetup: "wait for break",
    idealEntryZone: { low: null, high: null, notes: "none" }, invalidation: "breakdown",
    targets: [], requiredConfirmation: [], risks: ["noise"], confidence: 55, limitations: ["limited data"],
  };
  assert.equal(BlindAssessmentSchema.parse(blind).action, "WAIT");
  assert.throws(() => BlindAssessmentSchema.parse({ ...blind, outcome: "WIN" }));
  assert.throws(() => SignalComparisonSchema.parse({ grade: "A" }));
  assert.throws(() => OutcomeReviewSchema.parse({
    outcomeSummary: "done", thesisValidation: "SUPPORTED", entryReview: "ok",
    managementObservations: [], lessons: [], originalGradeStillInformative: true,
    limitations: [], grade: "A",
  }));
});

test("canonical hashes are stable across key order and exclude storage identifiers", () => {
  const first = withCanonicalHash({ schemaVersion: "v1", value: { b: 2, a: 1 }, createdAt: new Date("2026-01-01T00:00:00Z") });
  const second = withCanonicalHash({ _id: "mongo-local", createdAt: new Date("2026-01-01T00:00:00Z"), value: { a: 1, b: 2 }, schemaVersion: "v1" });
  assert.equal(first.canonicalHash, second.canonicalHash);
  assert.equal(Object.isFrozen(first), true);
  assert.match(first.canonicalHash, /^[a-f0-9]{64}$/);
  const binaryA = withCanonicalHash({ schemaVersion: "v1", png: new Binary(Buffer.from("png")) });
  const binaryB = withCanonicalHash({ schemaVersion: "v1", png: new Binary(Buffer.from("png")) });
  assert.equal(binaryA.canonicalHash, binaryB.canonicalHash);
});

test("canonical persistence recursively omits undefined object properties deterministically", () => {
  const input = {
    schemaVersion: "v1", optional: undefined,
    nested: { kept: 1, optional: undefined, deeper: { kept: true, optional: undefined } },
    values: [{ kept: "x", optional: undefined }, undefined],
  };
  const persisted = withCanonicalHash(input);
  const equivalent = withCanonicalHash({
    schemaVersion: "v1", nested: { deeper: { kept: true }, kept: 1 }, values: [{ kept: "x" }, null],
  });
  assert.equal(Object.hasOwn(input, "optional"), true);
  assert.equal(Object.hasOwn(input.nested, "optional"), true);
  assert.equal(Object.hasOwn(persisted, "optional"), false);
  assert.equal(Object.hasOwn(persisted.nested, "optional"), false);
  assert.equal(Object.hasOwn(persisted.nested.deeper, "optional"), false);
  assert.deepEqual(persisted.values, [{ kept: "x" }, null]);
  assert.equal(persisted.canonicalHash, equivalent.canonicalHash);
});
