const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_CATEGORY,
  EXECUTION_MODE,
  buildTradeMetadata,
  snapshotTradeMetadata,
} = require("../services/tradeMetadata");

const sessionDecision = {
  sessionLabel: "NY_WINDOW",
  label: "13:30-23:59 IST",
};

test("live and shadow metadata use the same deterministic schema", () => {
  const live = buildTradeMetadata({
    executionMode: EXECUTION_MODE.LIVE,
    sessionDecision,
    entryMeta: { reason: "SCORE" },
  });
  const shadow = buildTradeMetadata({
    executionMode: EXECUTION_MODE.SHADOW,
    sessionDecision,
    entryMeta: { reason: "SCORE" },
  });

  assert.deepEqual(live, {
    executionMode: "LIVE",
    sessionLabel: "NY_WINDOW",
    sessionWindow: "13:30-23:59 IST",
    category: DEFAULT_CATEGORY,
  });
  assert.deepEqual(shadow, { ...live, executionMode: "SHADOW" });
});

test("explicit category is normalized without changing entry reason", () => {
  const metadata = buildTradeMetadata({
    executionMode: EXECUTION_MODE.LIVE,
    sessionDecision,
    entryMeta: { reason: "SCORE", category: " breakout " },
  });

  assert.equal(metadata.category, "BREAKOUT");
});

test("snapshot metadata persists execution mode, session, window, and category", () => {
  const metadata = snapshotTradeMetadata(
    {
      executionMode: "LIVE",
      sessionLabel: "LONDON_WINDOW",
      sessionWindow: "13:30-23:59 IST",
      category: "STRATEGY",
    },
    EXECUTION_MODE.SHADOW,
  );

  assert.deepEqual(metadata, {
    executionMode: "LIVE",
    sessionLabel: "LONDON_WINDOW",
    sessionWindow: "13:30-23:59 IST",
    category: "STRATEGY",
  });
});

test("metadata rejects unsupported modes and missing session decisions", () => {
  assert.throws(
    () =>
      buildTradeMetadata({
        executionMode: "PAPER",
        sessionDecision,
        entryMeta: null,
      }),
    /Unsupported execution mode/,
  );
  assert.throws(
    () =>
      buildTradeMetadata({
        executionMode: EXECUTION_MODE.LIVE,
        sessionDecision: null,
        entryMeta: null,
      }),
    /Session decision metadata is required/,
  );
});
