// src/trade/brokerSync.js

const {
  openPairs,
  ticketOwnershipMap,
  registerTicketOwnership
} = require('./tradeRegistry');

let getPositionsFn = null;

/*
Allows market adapter to inject broker position fetcher
*/
function setBrokerPositionFetcher(fn) {
  getPositionsFn = fn;
}

/*
Sync openPairs with broker positions
*/
async function syncOpenPairsWithPositions() {

  if (!getPositionsFn) {
    console.warn('[SYNC] Position fetcher not configured');
    return;
  }

  let positions;

  try {

    positions = await getPositionsFn();

  } catch (err) {

    console.error('[SYNC] Failed to fetch positions:', err.message || err);
    return;

  }

  if (!Array.isArray(positions)) return;

  const brokerTickets = new Set();

  for (const p of positions) {

    const ticket =
      String(p.positionId || p.ticket || p.id || '');

    if (!ticket) continue;

    brokerTickets.add(ticket);

    const ownedBy = ticketOwnershipMap.get(ticket);

    if (ownedBy) continue;

    for (const pairId of Object.keys(openPairs)) {

      const rec = openPairs[pairId];

      if (!rec) continue;

      if (rec.trades.TRAILING.ticket) continue;

      const brokerSide =
        String(p.type || p.side || '').toUpperCase();

      const recSide = String(rec.side).toUpperCase();

      if (!brokerSide.includes(recSide)) continue;

      const vol = Number(p.volume || 0);

      if (Math.abs(vol - rec.lotEach) > 0.0001) continue;

      const brokerTicket =
        String(p.positionId || p.ticket || p.id);

      rec.trades.TRAILING.ticket = brokerTicket;

      registerTicketOwnership(brokerTicket, pairId);

      rec.state = 'ACTIVE';

      console.log(
        `[SYNC] Adopted EXNESS mirror LEG2 for ${pairId}:`,
        brokerTicket
      );

      break;

    }

  }

  /*
  Detect missing trades
  */

  for (const pairId of Object.keys(openPairs)) {

    const rec = openPairs[pairId];

    if (!rec) continue;

    const t1 = rec.trades.PARTIAL.ticket;
    const t2 = rec.trades.TRAILING.ticket;

    if (t1 && !brokerTickets.has(String(t1))) {

      console.log(`[SYNC] PARTIAL leg missing for ${pairId}`);

      rec.trades.PARTIAL.ticket = null;

    }

    if (t2 && !brokerTickets.has(String(t2))) {

      console.log(`[SYNC] TRAILING leg missing for ${pairId}`);

      rec.trades.TRAILING.ticket = null;

    }

  }

}

module.exports = {
  syncOpenPairsWithPositions,
  setBrokerPositionFetcher
};