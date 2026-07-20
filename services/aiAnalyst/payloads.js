const { assertPrivateIdentifiersAbsent, RedactionRejectedError } = require("./privacy");

function exactObject(source, keys, stage) {
  const unexpected = Object.keys(source || {}).filter((key) => !keys.includes(key));
  if (unexpected.length) throw new RedactionRejectedError(stage, unexpected[0], "field not permitted for stage");
  return keys.reduce((result, key) => {
    if (source[key] !== undefined) result[key] = source[key];
    return result;
  }, {});
}

function buildBlindPayload(input) {
  const payload = exactObject(input, [
    "correlationId", "timestamp", "symbol", "bid", "ask", "spread",
    "sessionLabel", "candles", "charts",
  ], "BLIND");
  assertPrivateIdentifiersAbsent(payload, "BLIND");
  return Object.freeze(payload);
}

function buildComparisonPayload(input) {
  const payload = exactObject(input, [
    "blindAssessment", "actualDirection", "actualEntry", "actualSL", "actualTP", "executionMode",
  ], "COMPARISON");
  if (!["LIVE", "SHADOW"].includes(payload.executionMode)) {
    throw new RedactionRejectedError("COMPARISON", "executionMode", "must be LIVE or SHADOW");
  }
  assertPrivateIdentifiersAbsent(payload, "COMPARISON");
  return Object.freeze(payload);
}

function buildOutcomePayload(input) {
  const payload = exactObject(input, ["blindAssessment", "comparison", "finalOutcome"], "OUTCOME");
  payload.finalOutcome = exactObject(payload.finalOutcome || {}, [
    "exitPrice", "closedAt", "durationSec", "closingReason", "result", "netPnL",
    "realizedR", "partialClosed", "breakEvenActive",
  ], "OUTCOME");
  assertPrivateIdentifiersAbsent(payload, "OUTCOME");
  return Object.freeze(payload);
}

module.exports = { buildBlindPayload, buildComparisonPayload, buildOutcomePayload, exactObject };
