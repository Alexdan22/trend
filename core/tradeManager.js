// core/tradeManager.js
// Trade lifecycle management - CommonJS

const { safeClosePosition, safeModifyPosition, safeGetPositions } = require('./orderHandler');
const { getPrice } = require('./account');
const { safeLog, MIN_LOT, LOT_ROUND } = require('./utils');
const { determineMarketTypeFromBB } = require('./indicators');

let openTradeRecords = {};

async function syncOpenTradeRecordsWithPositions(positions) {
  const currentTickets = positions.map(p => p.positionId || p.ticket || p.id).filter(Boolean);
  for (const t of Object.keys(openTradeRecords)) {
    if (!currentTickets.includes(t)) {
      safeLog('Trade closed externally:', t);
      delete openTradeRecords[t];
    }
  }

  for (const pos of positions) {
    const ticket = pos.positionId || pos.ticket || pos.id;
    if (!ticket) continue;
    if (!openTradeRecords[ticket]) {
      openTradeRecords[ticket] = {
        ticket,
        side: pos.side || (pos.type === 'buy' ? 'BUY' : 'SELL'),
        lot: pos.volume || pos.size || 0,
        sl: pos.stopLoss || null,
        tp: pos.takeProfit || null,
        entryPrice: pos.openPrice || pos.averagePrice,
        riskPercent: 0,
        openedAt: pos.openTime || new Date().toISOString(),
        partialClosed: false,
        trailedTo: null
      };
    }
  }
}

async function registerNewOpenTrade(res, side, lot, sl, tp, riskPercent) {
  const ticket = res?.positionId || res?.orderId || res?.ticket || `local-${Date.now()}`;
  openTradeRecords[ticket] = {
    ticket,
    side,
    lot,
    sl,
    tp,
    riskPercent,
    openedAt: new Date().toISOString(),
    partialClosed: false
  };
  safeLog('[TRADE] Registered new trade:', ticket);
}

async function monitorOpenTrades(ind30, ind5, ind1) {
  const positions = await safeGetPositions();
  await syncOpenTradeRecordsWithPositions(positions);
  const trend = determineMarketTypeFromBB(ind30?.values || [], ind30?.bb || []);

  for (const pos of positions) {
    const ticket = pos.positionId || pos.ticket || pos.id;
    const rec = openTradeRecords[ticket];
    if (!rec) continue;

    const price = await getPrice(pos.symbol);
    if (!price) continue;
    const currentPrice = rec.side === 'BUY' ? price.bid : price.ask;
    const totalDistance = Math.abs(rec.tp - rec.entryPrice);
    const currentDistance = Math.abs(rec.tp - currentPrice);
    const progress = 1 - currentDistance / totalDistance;

    // partial close
    if (!rec.partialClosed && progress >= 0.5) {
      const halfVol = Math.max(MIN_LOT, parseFloat((rec.lot / 2).toFixed(LOT_ROUND)));
      const closeRes = await safeClosePosition(ticket, halfVol);
      if (closeRes.ok) {
        rec.partialClosed = true;
        rec.lot = parseFloat((rec.lot - halfVol).toFixed(LOT_ROUND));
        safeLog(`[TRADE] Partial close on ${ticket}`);
      }
    }

    // trailing or exit if trend weakens
    if (trend === 'sideways') {
      await safeClosePosition(ticket, rec.lot);
      delete openTradeRecords[ticket];
      safeLog(`[TRADE] Closed ${ticket} due to weak trend`);
    } else {
      // trailing logic example: move SL closer to current price
      const atr = ind5.atr.at(-1) || 0;
      if (atr > 0) {
        const newSL = rec.side === 'BUY' ? currentPrice - atr : currentPrice + atr;
        if (
          (rec.side === 'BUY' && newSL > rec.sl) ||
          (rec.side === 'SELL' && newSL < rec.sl)
        ) {
          await safeModifyPosition(ticket, { stopLoss: newSL });
          rec.sl = newSL;
          rec.trailedTo = newSL;
          safeLog(`[TRADE] Trailed SL for ${ticket} to ${newSL}`);
        }
      }
    }
  }
}

module.exports = {
  syncOpenTradeRecordsWithPositions,
  registerNewOpenTrade,
  monitorOpenTrades,
  openTradeRecords
};
