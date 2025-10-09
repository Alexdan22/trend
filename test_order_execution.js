// test_order_pair_simulation_fixed_final_close.js
// Simulates clubbed trade pairs: one for partial-close, one for trailing SL.
// Minimal edits: ledger updates and robust final-close handling.
require('dotenv').config();
const MetaApi = require('metaapi.cloud-sdk').default;
const { setTimeout: delay } = require('timers/promises');

const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
const SYMBOL = process.env.SYMBOL || 'XAUUSDm';

const LOT_TOTAL = 0.2;           // total per pair
const PAIR_SPLIT = 0.5;          // half each
const MAX_PAIRS = 3;
const MIN_LOT = 0.01;
const SLOW_DELAY = 8000;
const WAIT_AFTER_CLOSE = 12000;

let virtualTradePairs = [];

function safeLog(...args) { console.log(...args); }

// -------------------- SAFE HELPERS (unchanged behaviour) --------------------
async function safeGetPrice(connection, symbol) {
  try {
    const p = connection.terminalState.price(symbol);
    if (p && p.bid && p.ask) return p;
  } catch {}
  return null;
}

async function safeGetAccountBalance(connection) {
  try {
    const info = connection.terminalState.accountInformation;
    if (info?.balance != null) return info.balance;
  } catch {}
  return 0;
}

async function safePlaceMarketOrder(connection, side, lot, sl, tp) {
  try {
    if (side === 'BUY' && typeof connection.createMarketBuyOrder === 'function')
      return await connection.createMarketBuyOrder(SYMBOL, lot, { stopLoss: sl, takeProfit: tp });
    if (side === 'SELL' && typeof connection.createMarketSellOrder === 'function')
      return await connection.createMarketSellOrder(SYMBOL, lot, { stopLoss: sl, takeProfit: tp });
    if (typeof connection.createMarketOrder === 'function')
      return await connection.createMarketOrder({
        symbol: SYMBOL,
        type: side.toLowerCase(),
        volume: lot,
        stopLoss: sl,
        takeProfit: tp
      });
  } catch (e) {
    safeLog(`[ORDER] ${side} ${lot} failed: ${e.message}`);
  }
  return null;
}

async function safeModifyPosition(connection, positionId, params) {
  try {
    if (typeof connection.modifyPosition === 'function')
      return await connection.modifyPosition(positionId, params);
  } catch (e) {
    safeLog(`[MODIFY] Failed for ${positionId}: ${e.message}`);
  }
}

// Robust positions fetch (keeps previous working attempts)
async function safeGetPositions(account, connection) {
  try {
    if (account && typeof account.getPositions === 'function') {
      const p = await account.getPositions();
      if (Array.isArray(p)) return p;
    }
  } catch {}
  try {
    if (connection?.terminalState?.positions) {
      const p = connection.terminalState.positions;
      if (Array.isArray(p)) return p;
    }
  } catch {}
  // fallthrough: empty
  return [];
}

// -------------------- safe close with tolerant behavior --------------------
async function safeClosePosition(connection, positionId) {
  try {
    if (typeof connection.closePosition === 'function') {
      const res = await connection.closePosition(positionId);
      return { ok: true, res };
    }
  } catch (e) {
    // treat "Position not found" as success (already closed)
    const msg = (e && (e.message || '')).toString();
    if (/position not found/i.test(msg) || /not found/i.test(msg) || /Invalid ticket/i.test(msg)) {
      return { ok: true, res: null, alreadyClosed: true };
    }
    return { ok: false, error: e };
  }
  // no close method available
  return { ok: false, error: new Error('No closePosition method available') };
}

// -------------------- MAIN LOGIC (keeps your working flow) --------------------
(async () => {
  try {
    safeLog(`🚀 Starting trade pair simulation (fixed final-close) for ${SYMBOL}`);

    const api = new MetaApi(METAAPI_TOKEN);
    const account = await api.metatraderAccountApi.getAccount(ACCOUNT_ID);

    if (account.state !== 'DEPLOYED') {
      safeLog('Deploying account...');
      await account.deploy();
      await account.waitConnected();
    }

    const connection = account.getStreamingConnection();
    await connection.connect();
    if (typeof connection.waitSynchronized === 'function') await connection.waitSynchronized();

    safeLog('✅ Connected to MetaApi.');

    const info = connection.terminalState.accountInformation || {};
    safeLog(`🔎 Account Mode: ${info.hedgingEnabled ? 'HEDGING' : 'NETTING'}`);

    const balance = await safeGetAccountBalance(connection);
    safeLog('💰 Balance:', balance);

    // subscribe if available (keeps behavior you asked to preserve)
    try {
      if (typeof connection.subscribeToMarketData === 'function') {
        await connection.subscribeToMarketData(SYMBOL);
        safeLog(`[INIT] Subscribed to market data for ${SYMBOL}`);
      }
    } catch (e) {
      safeLog('[WARN] subscribeToMarketData failed:', e.message);
    }

    await delay(2000);
    const price = await safeGetPrice(connection, SYMBOL);
    if (!price) {
      safeLog(`⚠️ No live price for ${SYMBOL}`);
      return;
    }
    safeLog(`📈 ${SYMBOL} | Bid: ${price.bid} | Ask: ${price.ask}`);

    // ---------------- CREATE PAIRS (unchanged semantics) ----------------
    safeLog(`📦 Creating ${MAX_PAIRS} trade pairs...`);
    for (let i = 0; i < MAX_PAIRS; i++) {
      const pairId = `pair_${i + 1}`;
      const side = 'BUY'; // keep BUY only to match your requested workflow, change if needed
      const lotEach = +(LOT_TOTAL * PAIR_SPLIT).toFixed(2);
      const sl = side === 'BUY' ? price.bid - 20 : price.ask + 20;
      const tp = side === 'BUY' ? price.ask + 40 : price.bid - 40;

      safeLog(`🟢 Placing ${side} pair ${pairId} (${lotEach}+${lotEach})`);

      const partialOrder = await safePlaceMarketOrder(connection, side, lotEach, sl, tp);
      await delay(2000);
      const trailingOrder = await safePlaceMarketOrder(connection, side, lotEach, sl, tp);
      // store tickets (can be null if order failed)
      virtualTradePairs.push({
        id: pairId,
        side,
        totalLot: LOT_TOTAL,
        trades: [
          { type: 'PARTIAL', lot: lotEach, ticket: partialOrder?.positionId || partialOrder?.orderId || null },
          { type: 'TRAILING', lot: lotEach, ticket: trailingOrder?.positionId || trailingOrder?.orderId || null }
        ]
      });

      safeLog(`[PAIR] ${pairId} entered with 2 trades of ${lotEach} each.`);
      await delay(SLOW_DELAY);
    }

    safeLog('✅ All pairs placed.');
    safeLog('Current virtual ledger:');
    console.table(virtualTradePairs.map(p => ({
      id: p.id, side: p.side, totalLot: p.totalLot,
      partial: p.trades[0].ticket, trailing: p.trades[1].ticket
    })));

    // ---------------- CLOSE PARTIAL ----------------
    safeLog('⚙️ Closing all PARTIAL trades (and updating ledger)...');
    for (const pair of virtualTradePairs) {
      const partial = pair.trades.find(t => t.type === 'PARTIAL');
      if (partial?.ticket) {
        const result = await safeClosePosition(connection, partial.ticket);
        if (result.ok) {
          safeLog(`[PARTIAL CLOSE] Closed ${partial.ticket} (${pair.id})`);
          // Update ledger: mark partial ticket as removed (null)
          partial.ticket = null;
        } else {
          safeLog(`[PARTIAL CLOSE] Failed to close ${partial.ticket}:`, result.error && (result.error.message || result.error));
        }
        await delay(SLOW_DELAY);
      } else {
        safeLog(`[PARTIAL CLOSE] No ticket present for pair ${pair.id} (skipping)`);
      }
    }

    // ---------------- MODIFY TRAILING ----------------
    safeLog('🧭 Adjusting SL on TRAILING trades (only if ticket present)...');
    const newPrice = await safeGetPrice(connection, SYMBOL);
    for (const pair of virtualTradePairs) {
      const trailing = pair.trades.find(t => t.type === 'TRAILING');
      if (!trailing?.ticket) {
        safeLog(`[MODIFY] No trailing ticket for ${pair.id} (skip)`);
        continue;
      }
      const newSl = pair.side === 'BUY' ? newPrice.bid - 10 : newPrice.ask + 10;
      await safeModifyPosition(connection, trailing.ticket, { stopLoss: newSl });
      safeLog(`[MODIFY] ${pair.id} trailing SL moved -> ${newSl}`);
      await delay(SLOW_DELAY);
    }

    // ---------------- FINAL CLOSE (robust) ----------------
    safeLog(`🛑 Waiting ${WAIT_AFTER_CLOSE / 1000}s before final closure...`);
    await delay(WAIT_AFTER_CLOSE);

    // Re-fetch open positions and close those that still exist.
    const openPositions = await safeGetPositions(account, connection);
    const openIds = openPositions.map(p => p.positionId || p.id || p.ticket).filter(Boolean);

    safeLog('[FINAL] Currently open position ids on broker:', openIds);

    // Close trailing tickets if still exist, otherwise skip
    for (const pair of virtualTradePairs) {
      for (const t of pair.trades) {
        if (!t.ticket) continue; // already null -> skip
        // only attempt close if ticket exists on broker (openIds)
        if (openIds.includes(t.ticket)) {
          const res = await safeClosePosition(connection, t.ticket);
          if (res.ok) {
            safeLog(`[CLOSE] Closed ${t.ticket} (${pair.id})`);
            t.ticket = null; // update ledger
          } else {
            safeLog(`[CLOSE] Failed for ${t.ticket}:`, res.error && (res.error.message || res.error));
          }
          await delay(1500);
        } else {
          // ticket not found on broker (already closed) -> treat as closed and null out
          safeLog(`[CLOSE] Ticket ${t.ticket} not found on broker (treating as closed).`);
          t.ticket = null;
        }
      }
    }

    // Final verification: query broker for any positions left for symbol
    const finalPositions = await safeGetPositions(account, connection);
    const finalForSymbol = finalPositions.filter(p => (p.symbol || p.instrument || '').toString().includes(SYMBOL.replace(/m$/i, '')));
    safeLog('--- FINAL POSITIONS FOR SYMBOL ---', finalForSymbol.map(p => ({ id: p.positionId || p.id, vol: p.volume || p.lots || 0 })));

    if (finalForSymbol.length === 0) {
      safeLog('✅ All positions for symbol closed successfully.');
    } else {
      safeLog('⚠️ Some positions remain open for symbol. Manual inspection advised.');
    }

  } catch (err) {
    console.error('❌ Fatal error:', err.message || err);
  }
})();
