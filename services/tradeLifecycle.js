const PAIR_STATE = Object.freeze({
  CREATED: "CREATED",
  ENTRY_IN_PROGRESS: "ENTRY_IN_PROGRESS",
  ACTIVE: "ACTIVE",
  CLOSING: "CLOSING",
  CLOSED: "CLOSED",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [PAIR_STATE.CREATED]: [PAIR_STATE.ENTRY_IN_PROGRESS],
  [PAIR_STATE.ENTRY_IN_PROGRESS]: [PAIR_STATE.ACTIVE, PAIR_STATE.CLOSING],
  [PAIR_STATE.ACTIVE]: [PAIR_STATE.CLOSING],
  [PAIR_STATE.CLOSING]: [PAIR_STATE.CLOSED],
  [PAIR_STATE.CLOSED]: [],
});

class IllegalTradeStateTransitionError extends Error {
  constructor(pairId, currentState, nextState) {
    super(
      `Illegal trade state transition ${currentState || "UNKNOWN"} -> ${nextState || "UNKNOWN"} (${pairId || "UNKNOWN"})`,
    );
    this.name = "IllegalTradeStateTransitionError";
    this.pairId = pairId || null;
    this.currentState = currentState || null;
    this.nextState = nextState || null;
  }
}

function assertTransitionAllowed(rec, nextState) {
  if (!rec || !rec.state) {
    throw new IllegalTradeStateTransitionError(
      rec?.pairId,
      rec?.state,
      nextState,
    );
  }

  const allowed = ALLOWED_TRANSITIONS[rec.state] || [];
  if (!allowed.includes(nextState)) {
    throw new IllegalTradeStateTransitionError(
      rec.pairId,
      rec.state,
      nextState,
    );
  }
}

async function transitionTradeState(
  rec,
  nextState,
  { reason = null, persist = async () => {} } = {},
) {
  if (rec?.state === nextState) return false;
  assertTransitionAllowed(rec, nextState);

  const previous = {
    state: rec.state,
    closingReason: rec.closingReason,
    closedAt: rec.closedAt,
  };

  rec.state = nextState;
  if (nextState === PAIR_STATE.CLOSING && reason && !rec.closingReason) {
    rec.closingReason = reason;
  }
  if (nextState === PAIR_STATE.CLOSED && !rec.closedAt) {
    rec.closedAt = new Date();
  }

  try {
    await persist({
      state: rec.state,
      closingReason: rec.closingReason ?? null,
      closedAt: rec.closedAt ?? null,
    });
  } catch (error) {
    rec.state = previous.state;
    rec.closingReason = previous.closingReason;
    rec.closedAt = previous.closedAt;
    throw error;
  }

  return true;
}

function createPairFinalizer({
  getPair,
  transition,
  finalizePairRecord,
  buildSnapshot,
  saveSnapshot,
  releaseOwnership = () => {},
  removePair,
  onFinalized = () => {},
}) {
  const inFlight = new Map();

  async function run(pairId, requestedReason) {
    const rec = getPair(pairId);
    if (!rec) return { status: "MISSING", pairId, reason: requestedReason };

    const finalReason = rec.closingReason || requestedReason;

    if (rec.state !== PAIR_STATE.CLOSED) {
      if (rec.state !== PAIR_STATE.CLOSING) {
        await transition(rec, PAIR_STATE.CLOSING, finalReason);
      }
      await transition(rec, PAIR_STATE.CLOSED, finalReason);
    }

    const persistedReason = rec.closingReason || finalReason;
    await finalizePairRecord(pairId, persistedReason);
    await saveSnapshot(buildSnapshot(rec));

    releaseOwnership(rec);
    removePair(pairId);
    onFinalized(pairId, persistedReason);

    return {
      status: "FINALIZED",
      pairId,
      reason: persistedReason,
    };
  }

  function finalize(pairId, reason) {
    if (inFlight.has(pairId)) return inFlight.get(pairId);

    const promise = run(pairId, reason).finally(() => {
      if (inFlight.get(pairId) === promise) inFlight.delete(pairId);
    });
    inFlight.set(pairId, promise);
    return promise;
  }

  finalize.inFlightCount = () => inFlight.size;
  return finalize;
}

module.exports = {
  ALLOWED_TRANSITIONS,
  IllegalTradeStateTransitionError,
  PAIR_STATE,
  assertTransitionAllowed,
  createPairFinalizer,
  transitionTradeState,
};
