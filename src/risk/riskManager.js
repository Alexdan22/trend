const { checkMarketHours } = require('./marketHoursGuard');
const { checkEntryLock } = require('./entryLock');

/*
Risk Manager

Acts as a gate before execution.
*/

function evaluateRisk(symbol, signal) {

  if (!signal) {
    return { allowed: false };
  }

  const sessionOk = checkMarketHours();
  if (!sessionOk) {
    return {
      allowed: false,
      reason: "MARKET_CLOSED"
    };
  }

  const entryAllowed = checkEntryLock(symbol);
  if (!entryAllowed) {
    return {
      allowed: false,
      reason: "ENTRY_LOCKED"
    };
  }

  return {
    allowed: true,
    signal
  };
}

module.exports = {
  evaluateRisk
};