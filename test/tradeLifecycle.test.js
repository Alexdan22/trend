const test = require("node:test");
const assert = require("node:assert/strict");

const {
  IllegalTradeStateTransitionError,
  PAIR_STATE,
  createPairFinalizer,
  transitionTradeState,
} = require("../services/tradeLifecycle");
const {
  canReconcileBrokerTickets,
  clearMissingPartialTicket,
} = require("../services/tradeReconciliation");

function basePair(overrides = {}) {
  return {
    pairId: "pair-test",
    state: PAIR_STATE.ACTIVE,
    closingReason: null,
    closedAt: null,
    partialClosed: false,
    partialExitPrice: null,
    partialClosedAt: null,
    partialPnL: null,
    breakEvenActive: false,
    trades: {
      PARTIAL: { ticket: "partial-1", lot: 0.01 },
      TRAILING: { ticket: "trailing-1", lot: 0.01 },
    },
    ...overrides,
  };
}

test("valid transitions persist CLOSING then CLOSED deterministically", async () => {
  const rec = basePair();
  const updates = [];
  const persist = async (update) => updates.push({ ...update });

  await transitionTradeState(rec, PAIR_STATE.CLOSING, {
    reason: "STOP_LOSS",
    persist,
  });
  await transitionTradeState(rec, PAIR_STATE.CLOSED, { persist });

  assert.equal(rec.state, PAIR_STATE.CLOSED);
  assert.equal(rec.closingReason, "STOP_LOSS");
  assert.ok(rec.closedAt instanceof Date);
  assert.deepEqual(
    updates.map((update) => update.state),
    [PAIR_STATE.CLOSING, PAIR_STATE.CLOSED],
  );
});

test("illegal state transitions throw and are not silently persisted", async () => {
  const rec = basePair();
  let persisted = false;

  await assert.rejects(
    transitionTradeState(rec, PAIR_STATE.CLOSED, {
      persist: async () => {
        persisted = true;
      },
    }),
    (error) =>
      error instanceof IllegalTradeStateTransitionError &&
      error.currentState === PAIR_STATE.ACTIVE &&
      error.nextState === PAIR_STATE.CLOSED,
  );

  assert.equal(rec.state, PAIR_STATE.ACTIVE);
  assert.equal(persisted, false);
});

test("repeating the current state is an idempotent no-op", async () => {
  const rec = basePair();
  let persisted = false;
  const changed = await transitionTradeState(rec, PAIR_STATE.ACTIVE, {
    persist: async () => {
      persisted = true;
    },
  });

  assert.equal(changed, false);
  assert.equal(persisted, false);
  assert.equal(rec.state, PAIR_STATE.ACTIVE);
});

test("overlapping exit paths share one finalization and preserve first reason", async () => {
  const rec = basePair();
  const pairs = { [rec.pairId]: rec };
  const transitions = [];
  const persistedClosures = [];
  const snapshots = [];
  const released = [];
  const removed = [];
  let releaseClosingTransition;
  const closingBarrier = new Promise((resolve) => {
    releaseClosingTransition = resolve;
  });

  const transition = (record, nextState, reason) =>
    transitionTradeState(record, nextState, {
      reason,
      persist: async (update) => {
        transitions.push(update.state);
        if (update.state === PAIR_STATE.CLOSING) await closingBarrier;
      },
    });

  const finalize = createPairFinalizer({
    getPair: (pairId) => pairs[pairId],
    transition,
    finalizePairRecord: async (pairId, reason) => {
      persistedClosures.push({ pairId, reason });
    },
    buildSnapshot: (record) => ({
      tradeId: record.pairId,
      closingReason: record.closingReason,
    }),
    saveSnapshot: async (snapshot) => snapshots.push(snapshot),
    releaseOwnership: (record) => released.push(record.pairId),
    removePair: (pairId) => {
      removed.push(pairId);
      delete pairs[pairId];
    },
  });

  const stopLoss = finalize(rec.pairId, "STOP_LOSS");
  const syncClosed = finalize(rec.pairId, "SYNC_CLOSED");
  assert.strictEqual(stopLoss, syncClosed);
  assert.equal(finalize.inFlightCount(), 1);

  releaseClosingTransition();
  const [first, second] = await Promise.all([stopLoss, syncClosed]);

  assert.deepEqual(first, second);
  assert.equal(first.reason, "STOP_LOSS");
  assert.deepEqual(transitions, [PAIR_STATE.CLOSING, PAIR_STATE.CLOSED]);
  assert.deepEqual(persistedClosures, [
    { pairId: rec.pairId, reason: "STOP_LOSS" },
  ]);
  assert.deepEqual(snapshots, [
    { tradeId: rec.pairId, closingReason: "STOP_LOSS" },
  ]);
  assert.deepEqual(released, [rec.pairId]);
  assert.deepEqual(removed, [rec.pairId]);
  assert.equal(finalize.inFlightCount(), 0);

  const retry = await finalize(rec.pairId, "SYNC_CLOSED");
  assert.equal(retry.status, "MISSING");
  assert.equal(snapshots.length, 1);
});

test("CLOSING state blocks broker reconciliation during an overlapping exit", async () => {
  const rec = basePair();
  await transitionTradeState(rec, PAIR_STATE.CLOSING, {
    reason: "STOP_LOSS",
  });

  assert.equal(canReconcileBrokerTickets(rec), false);
  assert.equal(rec.partialClosed, false);
  assert.equal(rec.partialExitPrice, null);
});

test("missing partial ticket is recorded without fabricating a partial close", () => {
  const rec = basePair();
  const ticket = clearMissingPartialTicket(rec);

  assert.equal(ticket, "partial-1");
  assert.equal(rec.trades.PARTIAL.ticket, null);
  assert.equal(rec.partialTicketMissing, true);
  assert.equal(rec.partialClosed, false);
  assert.equal(rec.breakEvenActive, false);
  assert.equal(rec.partialExitPrice, null);
  assert.equal(rec.partialClosedAt, null);
  assert.equal(rec.partialPnL, null);
});
