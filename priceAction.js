// bot_merged.js
// Merged: main strategy bot + robust order execution helpers from test_order_execution.js
// - Base strategy and candle aggregation from your main bot
// - Robust order/position helpers, tolerant close behavior, and safe getters from your debug test
// NOTE: Test on demo before running live

require('dotenv').config()
const MetaApi = require('metaapi.cloud-sdk').default;
const { setTimeout: delay } = require('timers/promises');
const express = require('express');
const bodyParser = require('body-parser');

const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000;

// Idempotency
const processedSignalIds = new Set();
const MAX_PER_CATEGORY = 2;
// 15-minute cooldown between trades of the same side (BUY or SELL)
const SIDE_COOLDOWN_MS = 15 * 60 * 1000;
const lastEntryTime = { BUY: 0, SELL: 0 };



// --------------------- CONFIG ---------------------
const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
const SYMBOL = process.env.SYMBOL || "XAUUSDm"; // change to XAUUSDm/GOLD/etc. per broker
const MIN_LOT = 0.01; // minimum lot size per broker
// ---------------- LOT SIZING ----------------
let FIXED_LOT = 0.02;   // default lot size for ALL trades




// --------------------- TELEGRAM SETUP ---------------------
const TelegramBot = require('node-telegram-bot-api');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let tgBot = null;


if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
  tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
  console.log('📲 Telegram bot connected.');
} else {
  console.warn('⚠️ Telegram credentials missing in .env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)');
}

async function sendTelegram(message, options = {}) {
  if (!tgBot || !TELEGRAM_CHAT_ID) return;
  try {
    await tgBot.sendMessage(TELEGRAM_CHAT_ID, message, options);
  } catch (e) {
    console.warn('❌ Telegram send failed:', e.message);
  }
}


// --------------------- STATE ---------------------
let api, account, connection;
let accountBalance = 0;


let latestPrice = null;   // { bid, ask, timestamp }
let lastTradeMonitorRun = 0;

const botStartTime = Date.now();
let lastTickPrice = null;
let stagnantTickCount = 0;
let stagnantSince = null;
let marketFrozen = false;
let openPairs = {}; // ticket -> metadata









// --------------------- ROBUST EXECUTION HELPERS (from test_order_execution.js) ---------------------
function safeLog(...args) { console.log(...args); }

async function safeGetPrice(symbol) {
  try {
    if (connection?.terminalState) {
      const p = connection.terminalState.price(symbol);
      if (p && p.bid != null && p.ask != null) {
        // good price from terminalState
        return p;
      } else {
        console.debug('[PRICE] terminalState price missing or incomplete for', symbol, p);
      }
    } else {
      console.debug('[PRICE] connection.terminalState not available');
    }
  } catch (e) {
    console.error('[PRICE] terminalState.price error', e);
  }

  // fallback 1: connection.getSymbolPrice
  try {
    if (connection && typeof connection.getSymbolPrice === 'function') {
      const p2 = await connection.getSymbolPrice(symbol);
      console.debug('[PRICE] connection.getSymbolPrice returned', p2);
      if (p2 && p2.bid != null && p2.ask != null) return p2;
    }
  } catch (e) {
    console.error('[PRICE] connection.getSymbolPrice error', e);
  }

  // fallback 2: account.getSymbolPrice
  try {
    if (account && typeof account.getSymbolPrice === 'function') {
      const p3 = await account.getSymbolPrice(symbol);
      console.debug('[PRICE] account.getSymbolPrice returned', p3);
      if (p3 && p3.bid != null && p3.ask != null) return p3;
    }
  } catch (e) {
    console.error('[PRICE] account.getSymbolPrice error', e);
  }

  // final null
  return null;
}

// Helpers
function normalizeCategory(type, side) {
  const t = (type || '').toUpperCase();
  const s = (side || '').toUpperCase();
  if ((t !== 'T' && t !== 'R') || (s !== 'BUY' && s !== 'SELL')) return null;
  return `${t}_${s}`; // T_BUY / R_BUY / T_SELL / R_SELL
}

function countCategory(category) {
  // Count only pairs still in "pair mode" — i.e., partial not closed
  return Object.values(openPairs)
    .filter(p => p.category === category && !p.partialClosed)
    .length;
}


function parseSignalString(signalStr) {
  const parts = signalStr.trim().toUpperCase().split(/\s+/);

  if (parts.length === 3 && (parts[0] === 'T' || parts[0] === 'R') &&
      (parts[1] === 'BUY' || parts[1] === 'SELL') && parts[2] === 'ENTRY') {
    return { kind: 'ENTRY', type: parts[0], side: parts[1] };
  }

  if (parts.length === 2 && (parts[0] === 'BUY' || parts[0] === 'SELL') && parts[1] === 'CLOSE') {
    return { kind: 'CLOSE', side: parts[0] };
  }

  return null;
}

async function internalLotSizing() {
  // For now: simply return fixed lot size.
  return FIXED_LOT;
}

async function internalSLTPLogic(side, entryPrice) {
  const SL_DISTANCE = 10; // points or dollars

  let sl = null;

  if (side === "BUY") {
    sl = entryPrice - SL_DISTANCE;
  } else {
    sl = entryPrice + SL_DISTANCE;
  }

  return {
    sl, 
    tp: null   // ALWAYS null, TradingView sends CLOSE signal instead
  };
}



// safeGetAccountBalance - tolerant retrieval
async function safeGetAccountBalance() {
  try {
    if (connection?.terminalState?.accountInformation?.balance != null)
      return connection.terminalState.accountInformation.balance;
  } catch (e) {}

  try {
    if (account?._data?.balance != null) return account._data.balance;
  } catch (e) {}

  return accountBalance || 0;
}


// safePlaceMarketOrder - robust attempts to call several API variants
async function safePlaceMarketOrder(action, lot, sl, tp) {
  try {
    if (!connection) throw new Error('No connection');
    if (action === 'BUY' && typeof connection.createMarketBuyOrder === 'function') {
      return await connection.createMarketBuyOrder(SYMBOL, lot, { stopLoss: sl, takeProfit: tp });
    }
    if (action === 'SELL' && typeof connection.createMarketSellOrder === 'function') {
      return await connection.createMarketSellOrder(SYMBOL, lot, { stopLoss: sl, takeProfit: tp });
    }
    if (typeof connection.createMarketOrder === 'function') {
      return await connection.createMarketOrder({
        symbol: SYMBOL,
        type: action === 'BUY' ? 'buy' : 'sell',
        volume: lot,
        stopLoss: sl,
        takeProfit: tp
      });
    }
    if (typeof connection.sendOrder === 'function') {
      return await connection.sendOrder({ symbol: SYMBOL, type: action === 'BUY' ? 'buy' : 'sell', volume: lot, stopLoss: sl, takeProfit: tp });
    }
  } catch (e) {
    safeLog(`[ORDER] ${action} ${lot} failed:`, e.message || e);
    throw e;
  }
  throw new Error('No supported market order method found on connection');
}


// --------------------- EXECUTION: Paired Order Placement ---------------------
async function placePairedOrder(side, totalLot, slPrice, tpPrice, riskPercent) {
  const lotEach = Number((totalLot / 2).toFixed(2));
  if (lotEach < MIN_LOT) {
    console.log('[PAIR] Computed lot too small — aborting.');
    return null;
  }

  let first = null;
  let second = null;

  try {
    // Place 1st leg (PARTIAL)
    first = await safePlaceMarketOrder(side, lotEach, null, null);

    // Slight spacing to avoid broker-side conflicts
    await delay(300);

    // Place 2nd leg (TRAILING)
    second = await safePlaceMarketOrder(side, lotEach, null, null);

  } catch (err) {
    console.error('[PAIR] Error placing paired orders:', err.message || err);

    // Rollback if partially placed
    try { if (first?.positionId) await safeClosePosition(first.positionId); } catch {}
    try { if (second?.positionId) await safeClosePosition(second.positionId); } catch {}

    return null;
  }

  // Construct internal pair record
  const pairId = `pair-${Date.now()}`;
  const entryPrice =
    side === 'BUY'
      ? (first?.price || latestPrice?.ask)
      : (first?.price || latestPrice?.bid);

  openPairs[pairId] = {
    pairId,
    side,
    riskPercent,

    totalLot: lotEach * 2,

    trades: {
      PARTIAL: {
        ticket: first?.positionId || first?.orderId || null,
        lot: lotEach
      },
      TRAILING: {
        ticket: second?.positionId || second?.orderId || null,
        lot: lotEach
      }
    },

    entryPrice,
    sl: slPrice,
    tp: tpPrice,

    breakEvenActive: false,
    internalSL: null,
    internalTrailingSL: null,

    partialClosed: false,

    openedAt: new Date().toISOString()
  };

  console.log(`[PAIR OPENED] ${pairId}`, openPairs[pairId]);
  return openPairs[pairId];
}



async function processTickForOpenPairs(price) {
  if (!price) return;
  try {
    const now = Date.now();
    const posList = await safeGetPositions();
    await syncOpenPairsWithPositions(posList);

    const openTickets = new Set((posList || []).map(p => p.positionId || p.ticket || p.id).filter(Boolean));

    // trailing config (single source of truth)
    const SL_DISTANCE = 10;      // initial SL distance from entry (points/dollars)
    const HALF_DISTANCE = SL_DISTANCE / 2; // first checkpoint
    const TRAIL_TRIGGER = 20;    // when price is > SL + 20, advance SL
    const TRAIL_STEP = SL_DISTANCE; // amount SL moves forward (10)

    for (const [pairId, rec] of Object.entries(openPairs)) {
      const side = rec.side;
      const partialRec = rec.trades?.PARTIAL;
      const trailingRec = rec.trades?.TRAILING;
      const entry = rec.entryPrice || rec.openPrice || null;

      // ensure we have an entry price to base SL moves on
      if (!entry) continue;

      // current price for checks (use bid for BUY, ask for SELL)
      const current = side === 'BUY' ? price.bid : price.ask;
      if (current == null) continue;

      // --- Ticket validity check (existing) ---
      if (partialRec?.ticket && !openTickets.has(partialRec.ticket)) {
        console.log(`[PAIR] Partial ticket ${partialRec.ticket} missing for ${pairId} — marking as closed.`);
        rec.trades.PARTIAL.ticket = null;
        rec.partialClosed = true;
      }
      if (trailingRec?.ticket && !openTickets.has(trailingRec.ticket)) {
        console.log(`[PAIR] Trailing ticket ${trailingRec.ticket} missing for ${pairId} — marking trailing null.`);
        rec.trades.TRAILING.ticket = null;
      }

      // --- Ensure there is a baseline SL (rec.sl may be set at entry) ---
      // If rec.sl is not set (should be set at entry step), initialize it to entry ± SL_DISTANCE as fallback
      if (rec.sl == null) {
        rec.sl = side === 'BUY' ? entry - SL_DISTANCE : entry + SL_DISTANCE;
      }

      // We'll use internal moving SL (rec.internalSL) if present, otherwise use rec.sl
      // If both absent we already set rec.sl above.
      if (rec.internalSL == null) rec.internalSL = rec.sl;

      // --- PRE-PARTIAL: checkpoint logic (before partial close triggered) ---
      if (!rec.partialClosed) {
        if (side === 'BUY') {
          // checkpoint 1: when price reaches entry + HALF_DISTANCE, move SL to entry - HALF_DISTANCE
          if (current >= entry + HALF_DISTANCE) {
            const desiredSL = entry - HALF_DISTANCE;
            if (rec.internalSL < desiredSL) { // move SL forward (less loss)
              rec.internalSL = desiredSL;
              console.log(`[PAIR][${pairId}] CHECKPOINT1 reached — SL moved to ${rec.internalSL.toFixed(2)}`);
              await sendTelegram(`🔷 *Checkpoint 1* — ${pairId}\nSide: BUY\nSL moved → ${rec.internalSL.toFixed(2)}`, { parse_mode: 'Markdown' });
            }
          }

          // checkpoint 2: when price reaches entry + SL_DISTANCE -> partial close + BE
          if (current >= entry + SL_DISTANCE) {
            // perform partial close if partial leg still exists
            if (partialRec?.ticket && !rec.partialClosed) {
              try {
                await safeClosePosition(partialRec.ticket, partialRec.lot);
                rec.partialClosed = true;
                rec.trades.PARTIAL.ticket = null;
                // Activate break-even
                rec.breakEvenActive = true;
                rec.internalSL = entry; // break-even
                console.log(`[PAIR][${pairId}] PARTIAL closed; BE set at ${rec.internalSL.toFixed(2)}`);
                await sendTelegram(
                  `🟠 *PARTIAL CLOSED + BREAK-EVEN SET*\nPair: ${pairId}\nSide: BUY\nPartial lot: ${partialRec.lot}\nBE (internal SL): ${rec.internalSL.toFixed(2)}`,
                  { parse_mode: 'Markdown' }
                );
                // Update account balance snapshot
                const newBal = await safeGetAccountBalance();
                if (newBal && newBal !== accountBalance) accountBalance = newBal;
              } catch (err) {
                console.warn(`[PAIR] Partial close failed for ${pairId}:`, err.message || err);
              }
            }
          }
        } else {
          // SELL symmetric
          if (current <= entry - HALF_DISTANCE) {
            const desiredSL = entry + HALF_DISTANCE;
            if (rec.internalSL > desiredSL) { // move SL forward (less loss for SELL)
              rec.internalSL = desiredSL;
              console.log(`[PAIR][${pairId}] CHECKPOINT1 reached — SL moved to ${rec.internalSL.toFixed(2)}`);
              await sendTelegram(`🔷 *Checkpoint 1* — ${pairId}\nSide: SELL\nSL moved → ${rec.internalSL.toFixed(2)}`, { parse_mode: 'Markdown' });
            }
          }

          if (current <= entry - SL_DISTANCE) {
            if (partialRec?.ticket && !rec.partialClosed) {
              try {
                await safeClosePosition(partialRec.ticket, partialRec.lot);
                rec.partialClosed = true;
                rec.trades.PARTIAL.ticket = null;
                rec.breakEvenActive = true;
                rec.internalSL = entry; // break-even
                console.log(`[PAIR][${pairId}] PARTIAL closed; BE set at ${rec.internalSL.toFixed(2)}`);
                await sendTelegram(
                  `🟠 *PARTIAL CLOSED + BREAK-EVEN SET*\nPair: ${pairId}\nSide: SELL\nPartial lot: ${partialRec.lot}\nBE (internal SL): ${rec.internalSL.toFixed(2)}`,
                  { parse_mode: 'Markdown' }
                );
                const newBal = await safeGetAccountBalance();
                if (newBal && newBal !== accountBalance) accountBalance = newBal;
              } catch (err) {
                console.warn(`[PAIR] Partial close failed for ${pairId}:`, err.message || err);
              }
            }
          }
        }
      } // end pre-partial

      // --- POST-PARTIAL / TRAILING logic (only after BE or partialClosed) ---
      // If we have activated BE or partialClosed, enable step trailing
      if (rec.partialClosed || rec.breakEvenActive) {
        if (side === 'BUY') {
          // If price has moved sufficiently beyond current SL, advance SL to current - SL_DISTANCE
          const distanceFromSL = current - rec.internalSL;
          if (distanceFromSL > TRAIL_TRIGGER) {
            const newSL = current - TRAIL_STEP;
            // Only advance if newSL is greater than previous SL (i.e., moves forward)
            if (newSL > rec.internalSL) {
              const oldSL = rec.internalSL;
              rec.internalSL = newSL;
              console.log(`[PAIR][${pairId}] TRAIL advanced from ${oldSL.toFixed(2)} -> ${rec.internalSL.toFixed(2)} (price=${current.toFixed(2)})`);
              await sendTelegram(
                `➡️ *TRAIL ADVANCED*\nPair: ${pairId}\nSide: BUY\nOld SL: ${oldSL.toFixed(2)}\nNew SL: ${rec.internalSL.toFixed(2)}\nPrice: ${current.toFixed(2)}`,
                { parse_mode: 'Markdown' }
              );
            }
          }
        } else {
          // SELL trailing
          const distanceFromSL = rec.internalSL - current;
          if (distanceFromSL > TRAIL_TRIGGER) {
            const newSL = current + TRAIL_STEP;
            if (newSL < rec.internalSL) {
              const oldSL = rec.internalSL;
              rec.internalSL = newSL;
              console.log(`[PAIR][${pairId}] TRAIL advanced from ${oldSL.toFixed(2)} -> ${rec.internalSL.toFixed(2)} (price=${current.toFixed(2)})`);
              await sendTelegram(
                `➡️ *TRAIL ADVANCED*\nPair: ${pairId}\nSide: SELL\nOld SL: ${oldSL.toFixed(2)}\nNew SL: ${rec.internalSL.toFixed(2)}\nPrice: ${current.toFixed(2)}`,
                { parse_mode: 'Markdown' }
              );
            }
          }
        }
      } // end trailing

      // --- HARD STOP-LOSS HIT CHECK (use moving internalSL if present) ---
      // Use a tiny buffer for tolerance if configured
      const USE_SL_BUFFER = true;
      const SL_BUFFER_PCT = 0.0003;
      const buffer = USE_SL_BUFFER ? rec.entryPrice * SL_BUFFER_PCT : 0;
      const effectiveSL = rec.internalSL ?? rec.sl;

      const slHit =
        (side === 'BUY' && current <= effectiveSL - buffer) ||
        (side === 'SELL' && current >= effectiveSL + buffer);

      if (slHit) {
        console.log(`[PAIR] ⛔ STOP-LOSS hit for ${pairId} — closing both legs. (effectiveSL=${effectiveSL.toFixed(2)}, buffer=${buffer.toFixed(2)})`);

        for (const key of ['PARTIAL', 'TRAILING']) {
          const t = rec.trades[key];
          if (t?.ticket) {
            try {
              await safeClosePosition(t.ticket, t.lot);
              rec.trades[key].ticket = null;
              console.log(`[PAIR] Closed ${key} leg for ${pairId} due to SL hit.`);
            } catch (err) {
              console.warn(`[PAIR] Failed to close ${key} leg for ${pairId}:`, err.message);
            }
          }
        }

        delete openPairs[pairId];
        await sendTelegram(
          `⛔ *STOP-LOSS HIT — PAIR CLOSED*\n━━━━━━━━━━━━━━━\n🎫 *Pair:* ${pairId}\n📈 *Side:* ${side}\n💀 *SL:* ${effectiveSL.toFixed(2)}\n🕒 ${new Date().toLocaleTimeString()}`,
          { parse_mode: 'Markdown' }
        );

        const newBal = await safeGetAccountBalance();
        if (newBal && newBal !== accountBalance) accountBalance = newBal;
        continue; // skip further processing for this pair
      }

      // --- If both trade tickets are gone, cleanup pair ---
      if (!rec.trades.PARTIAL.ticket && !rec.trades.TRAILING.ticket) {
        delete openPairs[pairId];
      }
    }
  } catch (err) {
    console.error('[TICK-PROCESS] processTickForOpenPairs error:', err.message || err);
  }
}




// safeClosePosition - tolerant close; treat "not found" as already-closed success
async function safeClosePosition(positionId, volume) {
  try {
    if (connection && typeof connection.closePosition === 'function') {
      // some APIs accept (id, volume) others just (id)
      if (arguments.length >= 2) {
        return { ok: true, res: await connection.closePosition(positionId, volume) };
      } else {
        return { ok: true, res: await connection.closePosition(positionId) };
      }
    }
    if (connection && typeof connection.closePositionByTicket === 'function') {
      return { ok: true, res: await connection.closePositionByTicket(positionId, volume) };
    }
    if (account && typeof account.closePosition === 'function') {
      return { ok: true, res: await account.closePosition(positionId, volume) };
    }
  } catch (e) {
    const msg = (e && (e.message || '')).toString();
    if (/position not found/i.test(msg) || /not found/i.test(msg) || /Invalid ticket/i.test(msg)) {
      return { ok: true, res: null, alreadyClosed: true };
    }
    return { ok: false, error: e };
  }
  return { ok: false, error: new Error('No closePosition method available') };
}

// Robust positions fetch (tries many fallbacks)
async function safeGetPositions() {
  try {
    if (account && typeof account.getPositions === 'function') {
      const p = await account.getPositions();
      if (Array.isArray(p)) return p;
    }
  } catch (e) {}
  try {
    if (connection?.terminalState?.positions) {
      const p = connection.terminalState.positions;
      if (Array.isArray(p)) return p;
    }
  } catch (e) {}
  // fallback scanning other possible getters
  try {
    if (connection && typeof connection.getOpenPositions === 'function') {
      const p = await connection.getOpenPositions();
      if (Array.isArray(p)) return p;
    }
  } catch (e) {}
  return [];
}





// --------------------- TICK HANDLER (clean TradingView version) ---------------------
async function handleTick(tick) {
  try {
    const tickBid = tick.bid ?? tick.price;
    const tickAsk = tick.ask ?? tick.price;
    const tickPrice = tickBid ?? tickAsk;
    const tickTime = Date.now();

    // --- Update latestPrice (required for partial/BE logic) ---
    latestPrice = {
      bid: tickBid,
      ask: tickAsk,
      timestamp: tickTime
    };

    // --- Market Freeze Detection ---
    if (lastTickPrice !== null) {
      if (tickPrice !== lastTickPrice) {
        // Price moved → reset freeze counter
        if (marketFrozen) {
          marketFrozen = false;
          stagnantTickCount = 0;

          console.log(`[MARKET] ✅ Price feed resumed`);
          await sendTelegram(
            `✅ *MARKET ACTIVE AGAIN*\n━━━━━━━━━━━━━━━\n💹 Live price feed restored\n🕒 ${new Date().toLocaleTimeString()}`,
            { parse_mode: 'Markdown' }
          );
        } else {
          stagnantTickCount = 0;
        }
      } else {
        // Price did not move
        stagnantTickCount++;

        // After ~2 minutes (60 ticks @ 2s), consider frozen
        if (stagnantTickCount > 60 && !marketFrozen) {
          marketFrozen = true;
          stagnantSince = new Date().toISOString();

          console.warn(`[MARKET] ⚠️ Price feed frozen since ${stagnantSince}`);
          await sendTelegram(
            `⚠️ *MARKET FREEZE DETECTED*\n━━━━━━━━━━━━━━━\n📉 No price movement detected\n🕒 Since: ${new Date().toLocaleTimeString()}`,
            { parse_mode: 'Markdown' }
          );
        }

        // If frozen, STOP all tick-based logic
        if (marketFrozen) return;
      }
    }

    lastTickPrice = tickPrice;

    // --- Process internal SL/TP/BE/partial logic ---
    if (Object.keys(openPairs).length > 0) {
      try {
        await processTickForOpenPairs(latestPrice);
      } catch (err) {
        console.warn('[TICK] processTickForOpenPairs error:', err.message || err);
      }
    }

    // --- Backup monitor every 15 seconds ---
    if (Date.now() - lastTradeMonitorRun > 15000) {
      lastTradeMonitorRun = Date.now();
      try {
        await monitorOpenTrades();
      } catch (err) {
        console.error('[MONITOR ERROR]', err.message || err);
      }
    }

  } catch (err) {
    console.warn('[TICK] Error in handleTick:', err.message || err);
  }
}






// --------------------- SYNC: reconcile broker positions with tracked pairs ---------------------
async function syncOpenPairsWithPositions(positions) {
try {
  // Build a list of currently open tickets on broker side
  const openTickets = new Set(
    (positions || [])
      .map(p => p.positionId || p.ticket || p.id)
      .filter(Boolean)
  );

  // Step 1️⃣ — verify all locally tracked pairs
  for (const [pairId, rec] of Object.entries(openPairs)) {
    const pTicket = rec.trades?.PARTIAL?.ticket;
    const tTicket = rec.trades?.TRAILING?.ticket;

    // — Provide retry counters per pair
    rec._missingRetries = rec._missingRetries || { PARTIAL: 0, TRAILING: 0 };

    // Helper: retry check for missing trades
    async function verifyStillMissing(ticket, label) {
      rec._missingRetries[label]++;

      // wait a moment for MetaApi sync (lighter than account.refresh())
      await connection
        .waitSynchronized({ timeoutInSeconds: 5 })
        .catch(() => {});

      // re-check positions
      const refreshed = await safeGetPositions();
      const refreshedTickets = new Set(
        (refreshed || []).map(p => p.positionId || p.ticket || p.id).filter(Boolean)
      );

      // If it appears again, reset retry counter
      if (refreshedTickets.has(ticket)) {
        rec._missingRetries[label] = 0;
        return false; // not missing anymore
      }

      // After 3 retries → consider permanently missing
      return rec._missingRetries[label] >= 3;
    }

    // --- PARTIAL missing logic ---
    if (pTicket && !openTickets.has(pTicket)) {
      const confirmedMissing = await verifyStillMissing(pTicket, 'PARTIAL');
      if (confirmedMissing) {
        console.log(`[SYNC] PARTIAL trade ${pTicket} missing → marking closed (${pairId})`);
        rec.trades.PARTIAL.ticket = null;
        rec.partialClosed = true;
      }
    }

    // --- TRAILING missing logic ---
    if (tTicket && !openTickets.has(tTicket)) {
      const confirmedMissing = await verifyStillMissing(tTicket, 'TRAILING');
      if (confirmedMissing) {
        console.log(`[SYNC] TRAILING trade ${tTicket} missing → marking closed (${pairId})`);
        rec.trades.TRAILING.ticket = null;
      }
    }

    // If BOTH legs are gone → full cleanup
    if (!rec.trades.PARTIAL.ticket && !rec.trades.TRAILING.ticket) {
      console.log(`[SYNC] Both legs closed → deleting pair ${pairId}`);

      // Cleanup memory for this record
      delete rec._missingRetries;
      delete openPairs[pairId];
      continue;
    }
  }

  // Step 2️⃣ — Removed external singleton creation (TradingView bot shouldn't track manual trades)

} catch (e) {
  console.error('[SYNC] Error syncing positions:', e.message || e);
}
}



// --------------------- MONITOR: light backup & sync layer ---------------------
async function monitorOpenTrades() {
  try {
    // 1️⃣ Refresh current broker positions and sync local state
    const positions = await safeGetPositions();
    await syncOpenPairsWithPositions(positions);

    // 2️⃣ Light safety pass for each pair
    for (const [pairId, rec] of Object.entries(openPairs)) {
      const side = rec.side;
      const partial = rec.trades?.PARTIAL;
      const trailing = rec.trades?.TRAILING;

      // If both legs are gone, cleanup
      if (!partial?.ticket && !trailing?.ticket) {
        delete openPairs[pairId];
        continue;
      }

      // 3️⃣ Fetch latest price
      const price = await safeGetPrice(SYMBOL);
      if (!price || price.bid == null || price.ask == null) continue;

      const current = side === 'BUY' ? price.bid : price.ask;

    }
  } catch (err) {
    console.error('[MONITOR] error:', err.message || err);
  }
}






// --------------------- MAIN LOOP ---------------------

// --------------------- SAFE MAIN LOOP (replace your existing startBot) ---------------------
async function startBot() {
  const { setTimeout: delay } = require('timers/promises');

  // basic validation
  if (!process.env.METAAPI_TOKEN || !process.env.METAAPI_ACCOUNT_ID) {
    console.error('[BOT] METAAPI_TOKEN or METAAPI_ACCOUNT_ID missing in env - aborting start.');
    return;
  }

  // control variables
  let retryDelay = 2 * 60 * 1000; // start 2 minutes
  const MAX_DELAY = 20 * 60 * 1000;
  const MAINTENANCE_ALERT_THRESHOLD = 30 * 60 * 1000; // 30min

  let reconnecting = false;
  let lastTickTime = Date.now();
  let lastDisconnectTime = null;
  let maintenanceAlertSent = false;

  console.log(`[BOT] Starting MetaApi bot for ${SYMBOL} — PID ${process.pid}`);

  try {
    // initialize global API objects (do not shadow)
    api = api || new MetaApi(process.env.METAAPI_TOKEN);

    // fetch fresh account object from MetaApi server (important)
    account = await api.metatraderAccountApi.getAccount(process.env.METAAPI_ACCOUNT_ID);
    console.log('[METAAPI] Fetched account:', account.id, 'state=', account.state, 'connectionStatus=', account.connectionStatus);

    // ------------- ensure deployed + connected (server-side)
    if (account.state !== 'DEPLOYED') {
      console.log('[METAAPI] Account not DEPLOYED — deploying now...');
      await account.deploy();
      console.log('[METAAPI] deploy() called, now waiting for waitConnected()...');
    }

    // waitConnected will wait until broker connection established on MetaApi side
    if (account.connectionStatus !== 'CONNECTED') {
      console.log('[METAAPI] Waiting for account to connect to broker (waitConnected)...');
      try {
        await account.waitConnected({ timeoutInSeconds: 120 });
      } catch (err) {
        console.warn('[METAAPI] waitConnected() timed out or failed:', err.message || err);
        throw err;
      }
    }
    console.log('[METAAPI] Account appears CONNECTED to broker.');

    // ------------- create streaming connection and wait for synchronization
    connection = account.getStreamingConnection();

    console.log('[METAAPI] Connecting streaming connection...');
    await connection.connect();

    // waitSynchronized may throw — wrap to surface the error
    try {
      console.log('[METAAPI] Waiting for streaming synchronization (waitSynchronized)...');
      await connection.waitSynchronized({ timeoutInSeconds: 120 });
    } catch (err) {
      console.error('[METAAPI] waitSynchronized() failed:', err.message || err);
      throw err;
    }
    console.log('[METAAPI] ✅ Streaming connection synchronized.');

    // ------------- subscribe AFTER synchronized
    if (typeof connection.subscribeToMarketData === 'function') {
      try {
        await connection.subscribeToMarketData(SYMBOL);
        console.log(`[METAAPI] Subscribed to ${SYMBOL} market data.`);
      } catch (e) {
        console.warn('[METAAPI] subscribeToMarketData failed:', e.message || e);
      }
    } else {
      console.warn('[METAAPI] subscribeToMarketData() not present on connection object.');
    }

    // wait for first tick (with timeout)
    console.log('[METAAPI] Waiting for first valid tick (max 60s)...');
    const firstTickTimeout = Date.now() + 60 * 1000;
    while (Date.now() < firstTickTimeout) {
      const p = connection?.terminalState?.price?.(SYMBOL);
      if (p && p.bid != null && p.ask != null) {
        lastTickTime = Date.now();
        break;
      }
      await delay(500);
    }
    const pCheck = connection?.terminalState?.price?.(SYMBOL);
    if (!pCheck || pCheck.bid == null || pCheck.ask == null) {
      console.warn('[METAAPI] No first tick received within 60s after sync - continuing but watch logs.');
    } else {
      console.log('[METAAPI] First tick received.');
    }

    // fetch initial balance snapshot if available
    try {
      const info = connection?.terminalState?.accountInformation || {};
      accountBalance = info.balance || accountBalance || 0;
      console.log(`[METAAPI] Initial balance guess: ${accountBalance}`);
    } catch (e) { console.warn('[METAAPI] fetching initial balance failed', e.message); }

    // notify
    await sendTelegram(`✅ *BOT CONNECTED* — ${SYMBOL}\nBalance: ${accountBalance?.toFixed?.(2) ?? accountBalance}`, { parse_mode: 'Markdown' });

    // reset maintenance timers
    retryDelay = 2 * 60 * 1000;
    lastDisconnectTime = null;
    maintenanceAlertSent = false;
    reconnecting = false;

    // --- start tick poll
    const pollIntervalMs = 2000;
    setInterval(async () => {
      try {
        // guard: only process ticks when connection is synchronized & terminal state present
        if (!connection || !connection.synchronized || !connection.terminalState) {
          // connection not ready; skip
          return;
        }
        const price = connection.terminalState.price(SYMBOL);
        if (price && price.bid != null && price.ask != null) {
          lastTickTime = Date.now();
          await handleTick(price);
        }
      } catch (e) {
        console.warn('[POLL] error while polling tick:', e.message || e);
      }
    }, pollIntervalMs);

    // --- unified watchdog (non-overlapping)
    setInterval(async () => {
      if (reconnecting) return;
      try {
        const price = connection?.terminalState?.price?.(SYMBOL);
        const synced = !!connection?.synchronized;
        if (!price || price.bid == null || price.ask == null || !synced) {
          reconnecting = true;
          console.warn('[WATCHDOG] Feed lost or not synchronized. Running ensureConnection()');
          await ensureConnectionWithRefresh();
          reconnecting = false;
        }
      } catch (e) {
        reconnecting = false;
        console.error('[WATCHDOG] unexpected error:', e.message || e);
      }
    }, 15_000);




    // ---------- helper: ensureConnectionWithRefresh (re-reads account)
    async function ensureConnectionWithRefresh() {
      try {
        // re-get account (fresh server-side state) — important
        console.log('[METAAPI] Re-fetching account for validation...');
        account = await api.metatraderAccountApi.getAccount(process.env.METAAPI_ACCOUNT_ID);
        console.log('[METAAPI] account state:', account.state, 'connectionStatus:', account.connectionStatus);

        if (account.state !== 'DEPLOYED') {
          console.log('[METAAPI] account not DEPLOYED; calling deploy()');
          await account.deploy();
        }

        if (account.connectionStatus !== 'CONNECTED') {
          console.log('[METAAPI] account not CONNECTED to broker; waiting waitConnected() (60s)...');
          try {
            await account.waitConnected({ timeoutInSeconds: 60 });
          } catch (err) {
            console.warn('[METAAPI] waitConnected() failed during ensureConnection:', err.message || err);
            throw err;
          }
        }

        // safe recreate connection object and wait sync
        connection = account.getStreamingConnection();
        console.log('[METAAPI] reconnecting streaming connection...');
        await connection.connect();
        await connection.waitSynchronized({ timeoutInSeconds: 60 });
        console.log('[METAAPI] re-synchronized.');

        if (typeof connection.subscribeToMarketData === 'function') {
          try {
            await connection.subscribeToMarketData(SYMBOL);
            console.log('[METAAPI] re-subscribed to market data for', SYMBOL);
          } catch (e) {
            console.warn('[METAAPI] subscribeToMarketData failed on reconnect:', e.message || e);
          }
        }
        lastTickTime = Date.now();
      } catch (err) {
        console.error('[METAAPI] ensureConnectionWithRefresh failed:', err.message || err);
        // set disconnect time for maintenance alert
        if (!lastDisconnectTime) lastDisconnectTime = Date.now();
        const disconnectedFor = Date.now() - (lastDisconnectTime || Date.now());
        if (disconnectedFor >= MAINTENANCE_ALERT_THRESHOLD && !maintenanceAlertSent) {
          maintenanceAlertSent = true;
          await sendTelegram(`⚠️ BROKER CONNECTION ALERT — disconnected >30m`, { parse_mode: 'Markdown' });
        }
      }
    }

  } catch (err) {
    console.error(`[BOT] Fatal connection error: ${err.message || err}`);

    // maintenance alert
    if (!lastDisconnectTime) lastDisconnectTime = Date.now();
    const disconnectedFor = Date.now() - lastDisconnectTime;
    if (disconnectedFor >= MAINTENANCE_ALERT_THRESHOLD && !maintenanceAlertSent) {
      maintenanceAlertSent = true;
      await sendTelegram(`⚠️ BROKER CONNECTION ALERT — disconnected >30m`, { parse_mode: 'Markdown' });
    }

    // backoff and restart (non-blocking)
    console.log(`[BOT] Restarting in ${(retryDelay / 60000).toFixed(1)} min...`);
    setTimeout(() => {
      retryDelay = Math.min(retryDelay * 1.5, MAX_DELAY);
      startBot().catch(e => console.error('startBot restart failed:', e));
    }, retryDelay);

    return;
  }
}


startBot().catch(err => console.error('BOT start failed:', err));


// --------------------- WEBHOOK / TRADINGVIEW SIGNAL HANDLER ---------------------


// ---- MAIN HANDLER ----
async function handleTradingViewSignal(req, res) {
  try {
    const payload = req.body;

    if (!payload || !payload.signal) {
      return res.status(400).json({ ok: false, error: "Missing 'signal' in payload" });
    }

    const signalId = payload.signalId ? String(payload.signalId) : null;
    if (signalId && processedSignalIds.has(signalId)) {
      return res.status(200).json({ ok: true, message: "Duplicate ignored (idempotent)" });
    }

    const parsed = parseSignalString(payload.signal);
    if (!parsed) {
      return res.status(400).json({ ok: false, error: "Invalid signal format" });
    }

    // ENTRY signals
    if (parsed.kind === "ENTRY") {

      const category = normalizeCategory(parsed.type, parsed.side);
      if (!category) {
        return res.status(400).json({ ok: false, error: "Invalid category" });
      }

      // category limit
      if (countCategory(category) >= MAX_PER_CATEGORY) {
        return res.status(429).json({ ok: false, error: `Max trades reached for ${category}` });
      }

      if (global.entryLock) {
          return res.status(429).json({ ok: false, error: "Entry in progress" });
      }
      global.entryLock = true;


      // Mark signal ID before execution (avoid races)
      if (signalId) processedSignalIds.add(signalId);

      // 👉 LOT/SIZING/SL/TP WILL BE HANDLED INTERNALLY (not from webhook)
      const side = parsed.side;

            // ---- SIDE COOLDOWN CHECK ----
      const now = Date.now();
      if (now - lastEntryTime[side] < SIDE_COOLDOWN_MS) {
        const remaining = SIDE_COOLDOWN_MS - (now - lastEntryTime[side]);
        const mins = Math.ceil(remaining / 60000);
        return res.status(429).json({
          ok: false,
          error: `Cooldown active for ${side}. Try again in ${mins} min`
        });
      }

      // 1. Determine lot
      const totalLot = await internalLotSizing();

      // 2. Place order with no SL/TP
      const prePair = await placePairedOrder(side, totalLot, null, null);

      if (!prePair) {
        if (signalId) processedSignalIds.delete(signalId);
        return res.status(500).json({ ok: false, error: "Entry failed" });
      }

      // 3. Use actual entry price to compute SL
      const { sl } = await internalSLTPLogic(side, prePair.entryPrice);

      // 4. Apply internal SL to the pair
      openPairs[prePair.pairId].sl = sl;
      openPairs[prePair.pairId].tp = null; // ALWAYS null

      // 5. Tag category, notify
      openPairs[prePair.pairId].category = category;
      openPairs[prePair.pairId].signalId = signalId || null;
      
      lastEntryTime[side] = Date.now();
      global.entryLock = false;


      await sendTelegram(
        `🟢 *ENTRY* ${category}\n🎫 ${prePair.pairId}\n📈 ${side}\nSL: ${sl}\n🕒 ${new Date().toLocaleTimeString()}`,
        { parse_mode: "Markdown" }
      );


      return res.status(200).json({ ok: true, pair: openPairs[prePair.pairId] });
    }


    if (parsed.kind === "CLOSE") {
    const side = parsed.side; // BUY or SELL

    const toClose = Object.entries(openPairs)
      .filter(([id, rec]) => rec.side === side);

    if (signalId) processedSignalIds.add(signalId);

    for (const [pairId, rec] of toClose) {
      for (const key of ["PARTIAL", "TRAILING"]) {
        const t = rec.trades[key];
        if (t?.ticket) {
          await safeClosePosition(t.ticket, t.lot).catch(() => {});
          rec.trades[key].ticket = null;
        }
      }

      delete openPairs[pairId];

      await sendTelegram(
        `🔴 *CLOSE SIGNAL*\nClosed: ${pairId} (${side})`,
        { parse_mode: "Markdown" }
      );
    }

    return res.status(200).json({ ok: true, closed: toClose.length });
  }


    return res.status(400).json({ ok: false, error: "Unknown signal" });

  } catch (err) {
    console.error("[WEBHOOK] Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}


// ---- START EXPRESS SERVER ----
function startWebhookServer() {
  const app = express();
  app.use(bodyParser.json());

  app.post("/webhook", handleTradingViewSignal);
  app.get("/_health", (_, res) => res.send("OK"));

  app.listen(WEBHOOK_PORT, () =>
    console.log(`[WEBHOOK] Ready on port ${WEBHOOK_PORT}`)
  );
}

startWebhookServer();


 

process.on('SIGINT', async () => {
  console.log('🛑 Gracefully shutting down...');
  try {
    if (connection && typeof connection.unsubscribeFromMarketData === 'function') {
      await connection.unsubscribeFromMarketData(SYMBOL);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
