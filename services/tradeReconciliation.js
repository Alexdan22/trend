const { PAIR_STATE } = require("./tradeLifecycle");

function canReconcileBrokerTickets(rec) {
  return Boolean(
    rec &&
      rec.state !== PAIR_STATE.CLOSING &&
      rec.state !== PAIR_STATE.CLOSED,
  );
}

function clearMissingPartialTicket(rec) {
  const ticket = rec?.trades?.PARTIAL?.ticket || null;
  if (!ticket) return null;

  rec.trades.PARTIAL.ticket = null;
  rec.partialTicketMissing = true;

  // A missing broker ticket is not proof that the strategy's partial target
  // executed. Only markPartialOutcome may set partialClosed and its PnL fields.
  return ticket;
}

module.exports = {
  canReconcileBrokerTickets,
  clearMissingPartialTicket,
};
