const EXECUTION_MODE = Object.freeze({
  LIVE: "LIVE",
  SHADOW: "SHADOW",
});

const DEFAULT_CATEGORY = "STRATEGY";

function normalizeCategory(entryMeta) {
  const explicit = entryMeta?.category;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim().toUpperCase();
  }
  return DEFAULT_CATEGORY;
}

function buildTradeMetadata({ executionMode, sessionDecision, entryMeta }) {
  if (!Object.values(EXECUTION_MODE).includes(executionMode)) {
    throw new Error(`Unsupported execution mode: ${executionMode}`);
  }
  if (!sessionDecision?.sessionLabel || !sessionDecision?.label) {
    throw new Error("Session decision metadata is required");
  }

  return {
    executionMode,
    sessionLabel: sessionDecision.sessionLabel,
    sessionWindow: sessionDecision.label,
    category: normalizeCategory(entryMeta),
  };
}

function snapshotTradeMetadata(rec, defaultExecutionMode) {
  return {
    executionMode: rec.executionMode || defaultExecutionMode,
    sessionLabel: rec.sessionLabel ?? null,
    sessionWindow: rec.sessionWindow ?? null,
    category: rec.category || DEFAULT_CATEGORY,
  };
}

module.exports = {
  DEFAULT_CATEGORY,
  EXECUTION_MODE,
  buildTradeMetadata,
  normalizeCategory,
  snapshotTradeMetadata,
};
