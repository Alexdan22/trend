// src/execution/executionEngine.js

const {
  openPairs,
  registerRecentTicket,
  registerTicketOwnership
} = require('../trade/tradeRegistry');

const { safePlaceMarketOrder } = require('./orderManager');

const PAIR_STATE = Object.freeze({
  CREATED: "CREATED",
  ENTRY_IN_PROGRESS: "ENTRY_IN_PROGRESS",
  ACTIVE: "ACTIVE",
  CLOSING: "CLOSING",
  CLOSED: "CLOSED"
});

async function placePairedOrder(side, totalLot, slPrice, tpPrice) {

  try {

    const lotEach = Number((totalLot / 2).toFixed(2));

    if (lotEach < 0.01) {
      console.log('[PAIR] Computed lot too small — aborting.');
      return null;
    }

    const pairId = `pair-${Date.now()}`;
    const entryTimestamp = Date.now();

    let first = null;

    try {

      first = await safePlaceMarketOrder(
        side,
        lotEach,
        slPrice,
        tpPrice,
        1
      );

    } catch (err) {

      console.error('[PAIR] Error placing LEG1:', err.message || err);
      return null;

    }

    if (first?.ticket) {

      registerRecentTicket(first.ticket);
      registerTicketOwnership(first.ticket, pairId);

    }

    openPairs[pairId] = {

      pairId,
      side,
      lotEach,
      totalLot: lotEach * 2,

      trades: {

        PARTIAL: {
          ticket: first?.ticket || null,
          lot: lotEach
        },

        TRAILING: {
          ticket: null,
          lot: lotEach
        }

      },

      entryPrice:
        side === 'BUY'
          ? first?.raw?.price || first?.raw?.averagePrice || null
          : first?.raw?.price || first?.raw?.averagePrice || null,

      sl: slPrice,
      tp: tpPrice,

      breakEvenActive: false,
      internalSL: null,
      internalTrailingSL: null,
      partialClosed: false,

      openedAt: new Date(),

      state: PAIR_STATE.ENTRY_IN_PROGRESS,

      entryStartedAt: Date.now(),

      closingReason: null,
      closedAt: null,

      entryTimestamp,

      leg2Attempted: false,

      confirmDeadlineForLeg2: entryTimestamp + 3000,

      signalId: null

    };

    console.log(`[PAIR] LEG1 placed for ${pairId}, awaiting confirmation and possible EXNESS leg2`);

    return openPairs[pairId];

  } catch (err) {

    console.error('[PAIR] Fatal error:', err.message || err);
    return null;

  }
}

module.exports = {
  placePairedOrder,
  PAIR_STATE
};