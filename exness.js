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
const fs = require('fs');
const RAW_ORDERS_LOG = '/tmp/raw_order_responses.log';

const EXNESS_PORT = process.env.EXNESS_PORT || 5002;

// Idempotency
const processedSignalIds = new Set();
const MAX_PER_CATEGORY = 1;
// 15-minute cooldown between trades of the same side (BUY or SELL)
const SIDE_COOLDOWN_MS = 15 * 60 * 1000;
const ENTRY_TIMEOUT_MS = 20_000; // 20 seconds (safe for Exness)
const lastEntryTime = { BUY: 0, SELL: 0 };
const FALLBACK_SL_DISTANCE = 4;   // XAUUSD dollars
const FALLBACK_TP_DISTANCE = 8;   // XAUUSD dollars





// --------------------- CONFIG ---------------------
const SYMBOL = process.env.SYMBOL || "XAUUSDm"; // change to XAUUSDm/GOLD/etc. per broker
const MIN_LOT = 0.01; // minimum lot size per broker
// ---------------- LOT SIZING ----------------
let FIXED_LOT = 0.02;   // default lot size for ALL trades



// global map to track idempotency
const ticketOwnershipMap = new Map(); // ticket -> pairId




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
    // escape only unsafe characters WITHOUT breaking markdown syntax
    const safeMessage = message.replace(/([\[\]\(\)~`>#+\-=|{}\.!])/g, '\\$1');

    await tgBot.sendMessage(TELEGRAM_CHAT_ID, safeMessage, options);

  } catch (e) {
    console.warn('❌ Telegram send failed:', e.message);
  }
}


function md2(text) {
  return text
    // escape all MarkdownV2 reserved characters
    .replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
    // extra safety for hyphens (Telegram sometimes breaks even inside ranges)
    .replace(/-/g, '\\-');
}




// --------------------- STATE ---------------------
let api, account, connection;
let accountBalance = 0;

// --- INTERNAL CANDLES (for ATR & other features) ---
let candles_1m = [];   // array of {time, open, high, low, close}
let candles_3m = [];   // array of {time, open, high, low, close}
let candles_5m = [];   // array of {time, open, high, low, close}
const MAX_CANDLES = 500; // keep last N candles

// ATR / volatility config (tweakable)
const ATR_PERIOD = 14;                // ATR period measured in M5 candles
const ATR_TRIGGER_MULTIPLIER = 1.5;   // used to compute dynamic trigger = ATR * multiplier



let latestPrice = null;   // { bid, ask, timestamp }
let lastTradeMonitorRun = 0;
const PAIR_STATE = Object.freeze({
  CREATED: "CREATED",                 // object exists, no broker interaction yet
  ENTRY_IN_PROGRESS: "ENTRY_IN_PROGRESS", // LEG1 placed, LEG2 pending
  ACTIVE: "ACTIVE",                   // both legs confirmed
  CLOSING: "CLOSING",                 // close requested (SL / CLOSE / SYNC)
  CLOSED: "CLOSED"                    // terminal, immutable
});

const ENTRY_LOCK = {
  locked: false,
  lockedAt: null,
  reason: null,
};

const ENTRY_LOCK_TIMEOUT_MS = 30 * 1000; // 30 seconds hard safety
const USE_BROKER_SLTP = true; // 🔒 default OFF
const MAX_TP_DISTANCE = 30; // XAUUSD dollars
const MAX_SL_DISTANCE = 8; // XAUUSD dollars






let lastTickPrice = null;
let stagnantTickCount = 0;
let stagnantSince = null;
let marketFrozen = false;
let openPairs = {}; // ticket -> metadata

// Prevent newly placed trades from being marked as external
const recentTickets = new Set();



// ========================
// APPROVAL ZONE STORAGE
// ========================
globalThis.zoneApproval = {
  "T_BUY":  { "3M": false, "5M": false },
  "T_SELL": { "3M": false, "5M": false },
  "R_BUY":  { "3M": false, "5M": false },
  "R_SELL": { "3M": false, "5M": false }
};










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
  return Object.values(openPairs)
    .filter(p => 
        p.category === category &&
        !p.partialClosed &&                         // partial not closed
        p.trades?.PARTIAL?.ticket &&                // partial exists
        p.trades?.TRAILING?.ticket                  // trailing exists
    ).length;
}

function parseOrderResponse(res) {
  if (!res) return { ticket: null};

  // Try all known possible fields MetaApi returns
  const ticket =
    res.positionId ||
    res.orderId ||
    res.ticket ||
    res.id ||
    res?.result?.positionId ||
    res?.result?.orderId ||
    res?.result?.ticket ||
    res?.result?.id ||
    null;


  return { ticket};
}

function transitionPairState(rec, nextState, reason = null) {
  if (!rec || !rec.state) return false;

  // terminal guard
  if (rec.state === PAIR_STATE.CLOSED) {
    return false;
  }

  const allowedTransitions = {
    [PAIR_STATE.CREATED]: [PAIR_STATE.ENTRY_IN_PROGRESS],
    [PAIR_STATE.ENTRY_IN_PROGRESS]: [PAIR_STATE.ACTIVE, PAIR_STATE.CLOSING],
    [PAIR_STATE.ACTIVE]: [PAIR_STATE.CLOSING],
    [PAIR_STATE.CLOSING]: [PAIR_STATE.CLOSED]
  };

  const allowed = allowedTransitions[rec.state] || [];
  if (!allowed.includes(nextState)) {
    console.warn(
      `[STATE] Illegal transition ${rec.state} → ${nextState} (${rec.pairId})`
    );
    return false;
  }

  rec.state = nextState;
  if (nextState === PAIR_STATE.CLOSING && reason) {
    rec.closingReason = reason;
  }
  if (nextState === PAIR_STATE.CLOSED) {
    rec.closedAt = Date.now();
  }

  return true;
}

function finalizePair(pairId, reason) {
  const rec = openPairs[pairId];
  if (!rec) return;

  // Idempotency guard
  if (rec.state === PAIR_STATE.CLOSED) return;

  // Force correct lifecycle
  transitionPairState(rec, PAIR_STATE.CLOSED, reason);

  const partialTicket = rec.trades?.PARTIAL?.ticket;
  const trailingTicket = rec.trades?.TRAILING?.ticket;

  if (partialTicket) {
    ticketOwnershipMap.delete(String(partialTicket));
  }
  if (trailingTicket) {
    ticketOwnershipMap.delete(String(trailingTicket));
  }

  delete openPairs[pairId];

  console.log(
    `[PAIR] Finalized ${pairId} | reason=${reason}`
  );
}

function isEntryLocked() {
  if (!ENTRY_LOCK.locked) return false;

  // Safety auto-release
  if (Date.now() - ENTRY_LOCK.lockedAt > ENTRY_LOCK_TIMEOUT_MS) {
    console.warn('[ENTRY-LOCK] ⛔ Timeout exceeded → force unlock');
    releaseEntryLock('timeout-force');
    return false;
  }

  return true;
}

function acquireEntryLock(reason) {
  ENTRY_LOCK.locked = true;
  ENTRY_LOCK.lockedAt = Date.now();
  ENTRY_LOCK.reason = reason;

  console.log(`[ENTRY-LOCK] 🔒 Acquired → ${reason}`);
}

function releaseEntryLock(reason) {
  if (!ENTRY_LOCK.locked) return;

  console.log(`[ENTRY-LOCK] 🔓 Released → ${reason}`);

  ENTRY_LOCK.locked = false;
  ENTRY_LOCK.lockedAt = null;
  ENTRY_LOCK.reason = null;
}

function checkEntryTimeouts() {
  const now = Date.now();

  for (const [pairId, rec] of Object.entries(openPairs)) {
    if (rec.state !== PAIR_STATE.ENTRY_IN_PROGRESS) continue;


    const age = now - new Date(rec.openedAt).getTime();
    if (age < ENTRY_TIMEOUT_MS) continue;

    console.warn(`[ENTRY] ⛔ Timeout → abandoning ${pairId}`);

    // 1️⃣ cleanup / force close
    forceCloseAnyExistingLeg(rec);

    // 2️⃣ remove local state
    delete openPairs[pairId];

    // 3️⃣ 🔑 RELEASE ENTRY LOCK HERE
    releaseEntryLock('entry-timeout-abandon');
  }
}





function parseSignalString(signalStr) {
  const parts = signalStr.trim().toUpperCase().split(/\s+/);

  if (parts.length === 3 && (parts[0] === 'T' || parts[0] === 'R') &&
      (parts[1] === 'BUY' || parts[1] === 'SELL') && parts[2] === 'ENTRY') {
    return { kind: 'ENTRY', type: parts[0], side: parts[1] };
  }

  if (
    parts.length === 3 &&
    (parts[0] === 'T' || parts[0] === 'R') &&
    (parts[1] === 'BUY' || parts[1] === 'SELL') &&
    parts[2] === 'CLOSE'
  ) {
    return {
      kind: 'CLOSE',
      category: `${parts[0]}_${parts[1]}` // T_BUY, R_SELL, etc
    };
  }


  return null;
}

async function internalLotSizing() {
  // For now: simply return fixed lot size.
  return FIXED_LOT;
}

// --- ATR computed on 5m candles (true range average) ---
function computeATR_M5(period = ATR_PERIOD) {
  // need at least (period + 1) candles to compute TRs using prev.close
  if (candles_5m.length < period + 1) return 0;

  const start = candles_5m.length - period;
  const trs = [];

  for (let i = start; i < candles_5m.length; i++) {
    const curr = candles_5m[i];
    const prev = candles_5m[i - 1];
    if (!curr || !prev) continue;

    const highLow = curr.high - curr.low;
    const highClose = Math.abs(curr.high - prev.close);
    const lowClose = Math.abs(curr.low - prev.close);

    const tr = Math.max(highLow, highClose, lowClose);
    trs.push(tr);
  }

  if (trs.length === 0) return 0;
  const atr = trs.reduce((s, v) => s + v, 0) / trs.length;
  return atr;
}

function calculateDynamicSLTP(side, entryPrice) {
  // --- 1️⃣ ATR (M5) ---
  const atr = computeATR_M5(ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  // --- 2️⃣ Retracement depth (last 3 M5 candles) ---
  const recent = candles_5m.slice(-3);
  if (recent.length < 3) return null;

  const high = Math.max(...recent.map(c => c.high));
  const low  = Math.min(...recent.map(c => c.low));
  const retracement = Math.abs(high - low);

  // --- 3️⃣ SL distance ---
  const rawSlDistance = Math.max(
    retracement * 0.5,
    atr * ATR_TRIGGER_MULTIPLIER
  );

  // --- SL CAP OVERRIDE ---
  const SL_CAP = MAX_SL_DISTANCE; // e.g. 30 (same unit you already use)

  let slDistance = rawSlDistance;

  if (slDistance > SL_CAP) {
    slDistance = SL_CAP;
  }


  // --- 4️⃣ TP multiplier ---
  const tpRR = 2;
  
  let sl, tp;

  const rawTPDistance = slDistance * tpRR;
  const cappedTPDistance = Math.min(rawTPDistance, MAX_TP_DISTANCE);

  if (side === 'BUY') {
    sl = entryPrice - slDistance;
    tp = entryPrice + cappedTPDistance;
  } else {
    sl = entryPrice + slDistance;
    tp = entryPrice - cappedTPDistance;
  }


  return { sl, tp, slDistance };
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



// safePlaceMarketOrder - uses parseOrderResponse and returns { ticket, raw }
async function safePlaceMarketOrder(action, lot, sl, tp, legIndex = 0) {
  if (!connection) throw new Error("No connection");

  console.log("[ORDER] Using streaming API order method");

  const options = {};

  if (USE_BROKER_SLTP) {
    if (typeof sl === 'number') options.stopLoss = sl;
    if (typeof tp === 'number') options.takeProfit = tp;
  }

  try {
    let res;

    if (action === "BUY") {
      res = await connection.createMarketBuyOrder(
        SYMBOL,
        lot,
        Object.keys(options).length ? options : undefined
      );
    } else {
      res = await connection.createMarketSellOrder(
        SYMBOL,
        lot,
        Object.keys(options).length ? options : undefined
      );
    }

    const parsed = parseOrderResponse(res);
    const ticket = parsed.ticket || null;

    if (ticket) {
      recentTickets.add(ticket);
      setTimeout(() => recentTickets.delete(ticket), 15000);
    }

    return { ticket, raw: res };

  } catch (err) {
    console.error("[ORDER ERROR] Streaming order failed:", err.message);
    throw err;
  }
}







// --------------------- EXECUTION: Paired Order Placement ---------------------
async function placePairedOrder(side, totalLot, slPrice, tpPrice, riskPercent) {
  try {

    const lotEach = Number((totalLot / 2).toFixed(2));
    if (lotEach < MIN_LOT) {
      console.log('[PAIR] Computed lot too small — aborting.');
      return null;
    }

    // Create pair state
    const pairId = `pair-${Date.now()}`;
    const entryTimestamp = Date.now();


    // Place LEG1 only
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

    // Register ticket into recentTickets if present
    if (first?.ticket) {
      const t = String(first.ticket);
      recentTickets.add(t);
      ticketOwnershipMap.set(t, pairId);   // ✅ OWNERSHIP SET HERE
      setTimeout(() => recentTickets.delete(t), 15000);
    }


    // Build pair skeleton in openPairs
    openPairs[pairId] = {
      pairId,
      side,
      lotEach,
      riskPercent,
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
          ? (first?.raw?.price || first?.raw?.averagePrice || latestPrice?.ask || first?.price || null)
          : (first?.raw?.price || first?.raw?.averagePrice || latestPrice?.bid || first?.price || null),
      sl: slPrice,
      tp: tpPrice,
      breakEvenActive: false,
      internalSL: null,
      internalTrailingSL: null,
      partialClosed: false,
      openedAt: new Date().toISOString(),
      state: PAIR_STATE.ENTRY_IN_PROGRESS,
      entryStartedAt: Date.now(),
      closingReason: null,
      closedAt: null,
      entryTimestamp,
      leg2Attempted: false,
      confirmDeadlineForLeg2: entryTimestamp + 3000, // 3 seconds to allow Exness auto-create leg2
      signalId: null // will be set by caller
    };


    console.log(`[PAIR] LEG1 placed for ${pairId}, awaiting confirmation and possible EXNESS leg2`);
    return openPairs[pairId];

  } finally {
    // Does nothing
  }
}





async function processTickForOpenPairs(price) {
  if (!price) return;
  try {
    const now = Date.now();
    const posList = await safeGetPositions();
    await syncOpenPairsWithPositions(posList);

    const openTickets = new Set((posList || []).map(p => p.positionId || p.ticket || p.id).filter(Boolean));


    for (const [pairId, rec] of Object.entries(openPairs)) {

      if (rec.state === PAIR_STATE.CLOSED) continue;

      if (rec.state !== PAIR_STATE.ACTIVE) {
        continue;
      }

      // ---------------------------------------------------------------
      // Original age-based guard (you already have this)
      // ---------------------------------------------------------------
      const ageMs = Date.now() - new Date(rec.openedAt).getTime();
      if (ageMs < 5000) {
          console.log(`[TRAIL] Skipping ${pairId} (trade too new: ${ageMs}ms)`);
          continue;
      }

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
      // Don't treat missing tickets as missing during the first 5 seconds
      if (ageMs >= 5000) {
        if (partialRec?.ticket && !openTickets.has(partialRec.ticket)) {
          console.log(`[PAIR] Partial ticket ${partialRec.ticket} missing for ${pairId} — marking as closed.`);
          rec.trades.PARTIAL.ticket = null;
          rec.partialClosed = true;
        }

        const trailingTicket = rec.trades?.TRAILING?.ticket;


        if (trailingTicket && !openTickets.has(trailingTicket)) {
          // If trailing was just placed/placed recently, skip marking it null immediately.
          if (recentTickets.has(trailingTicket)) {
            console.log(`[PAIR] Trailing ticket ${trailingTicket} is recent — deferring missing-mark for ${pairId}`);
          } else {
            console.log(`[PAIR] Trailing ticket ${trailingTicket} missing for ${pairId} — marking trailing null.`);
            rec.trades.TRAILING.ticket = null;
          }
        }

      }

      // ---------- PARTIAL + BREAK-EVEN ----------
      if (!rec.partialClosed && rec.tp && rec.entryPrice && partialRec?.ticket) {

        const totalDist = Math.abs(rec.tp - rec.entryPrice);
        let movedDist;

        if (side === 'BUY') {
          movedDist = current - rec.entryPrice;
        } else {
          movedDist = rec.entryPrice - current;
        }

        if (movedDist > 0) {
          const progress = movedDist / totalDist;

          // 🔸 PARTIAL at 50% of TP distance
          if (progress >= 0.5) {

            await safeClosePosition(partialRec.ticket, partialRec.lot);
            rec.partialClosed = true;
            rec.trades.PARTIAL.ticket = null;

            // 🔸 ACTIVATE BREAK-EVEN
            rec.breakEvenActive = true;
            rec.internalSL = rec.entryPrice;

            console.log(`[PAIR][${pairId}] PARTIAL closed + BE activated`);

            const safePairId = md2(pairId);
            await sendTelegram(
              `🟠 *PARTIAL CLOSED + BREAK-EVEN*\n` +
              `${safePairId}\n` +
              `Side: ${side}\n` +
              `BE: ${rec.entryPrice.toFixed(2)}`,
              { parse_mode: 'MarkdownV2' }
            );
          }
        }
      }  // end pre-partial

      // ---------- TP HIT ----------
      if (rec.tp) {
        const tpHit =
          (side === 'BUY'  && current >= rec.tp) ||
          (side === 'SELL' && current <= rec.tp);

        if (tpHit) {

          transitionPairState(rec, PAIR_STATE.CLOSING, 'TP_HIT');

          for (const key of ['PARTIAL', 'TRAILING']) {
            const t = rec.trades[key];
            if (t?.ticket) {
              await safeClosePosition(t.ticket, t.lot);
              rec.trades[key].ticket = null;
            }
          }

          // 📣 TELEGRAM FIRST (state still exists here)
          const safePairId = md2(pairId);
          await sendTelegram(
            `🎯 *TP HIT — PROFIT CLOSED*\n` +
            `${safePairId}\n` +
            `Side: ${side}\n` +
            `TP: ${rec.tp.toFixed(2)}\n` +
            `Entry: ${rec.entryPrice.toFixed(2)}`,
            { parse_mode: 'MarkdownV2' }
          );

          // 🧹 FINALIZE AFTER NOTIFICATION
          finalizePair(pairId, 'TP_HIT');

          continue;
        }
      }

      // ---------- STOP-LOSS HIT ----------
      const effectiveSL = rec.internalSL ?? rec.sl;

      if (effectiveSL) {

        const slHit =
          (side === 'BUY'  && current <= effectiveSL) ||
          (side === 'SELL' && current >= effectiveSL);

        if (slHit) {

          console.log(`[PAIR] ⛔ STOP-LOSS HIT → closing pair (${pairId})`);

          transitionPairState(rec, PAIR_STATE.CLOSING, 'STOP_LOSS');

          // Close both legs defensively
          for (const key of ['PARTIAL', 'TRAILING']) {
            const t = rec.trades[key];
            if (t?.ticket) {
              await safeClosePosition(t.ticket, t.lot);
              rec.trades[key].ticket = null;
            }
          }

          const safePairId = md2(pairId);
          await sendTelegram(
            `⛔ *STOP-LOSS HIT — LOSS CLOSED*\n` +
            `${safePairId}\n` +
            `Side: ${side}\n` +
            `SL: ${effectiveSL.toFixed(2)}\n` +
            `Entry: ${rec.entryPrice.toFixed(2)}`,
            { parse_mode: 'MarkdownV2' }
          );

          finalizePair(pairId, 'STOP_LOSS');
          continue;
        }
      }



      // ---------- BREAK-EVEN HIT ----------
      if (rec.breakEvenActive && rec.internalSL && trailingRec?.ticket) {

        const beHit =
          (side === 'BUY'  && current <= rec.internalSL) ||
          (side === 'SELL' && current >= rec.internalSL);

        if (beHit) {

          console.log(`[PAIR] 🔵 BREAK-EVEN HIT → closing trailing leg (${pairId})`);

          await safeClosePosition(trailingRec.ticket, trailingRec.lot);
          rec.trades.TRAILING.ticket = null;

          finalizePair(pairId, 'BREAK_EVEN');

          const safePairId = md2(pairId);
          await sendTelegram(
            `🔵 *BREAK-EVEN HIT*\n${safePairId}\nSide: ${side}`,
            { parse_mode: 'MarkdownV2' }
          );

          continue;
        }
      }



      // --- If both trade tickets are gone, cleanup pair ---
      if (!rec.trades.PARTIAL.ticket && !rec.trades.TRAILING.ticket) {
        finalizePair(pairId, 'PAIR_CLOSED');
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
            { parse_mode: 'MarkdownV2' }
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
            { parse_mode: 'MarkdownV2' }
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

    // --- CANDLE BUILDER (1m, 3m, 5m) ---
    try {
      const nowMs = Date.now();
      const minuteBucket = Math.floor(nowMs / 60000) * 60000;       // 1m bucket (ms)
      const threeMinBucket = Math.floor(minuteBucket / 180000) * 180000; // 3m bucket (180000ms)
      const fiveMinBucket = Math.floor(minuteBucket / 300000) * 300000;  // 5m bucket (300000ms)

      const priceMid = (tick.bid != null && tick.ask != null) ? ((tick.bid + tick.ask) / 2) : (tick.bid ?? tick.ask ?? null);

      if (priceMid != null) {
        // 1m candle
        let last1 = candles_1m[candles_1m.length - 1];
        if (!last1 || last1.time !== minuteBucket) {
          candles_1m.push({ time: minuteBucket, open: priceMid, high: priceMid, low: priceMid, close: priceMid });
          if (candles_1m.length > MAX_CANDLES) candles_1m.shift();
        } else {
          last1.high = Math.max(last1.high, priceMid);
          last1.low  = Math.min(last1.low, priceMid);
          last1.close = priceMid;
        }

        // 3m candle (built directly from ticks)
        let last3 = candles_3m[candles_3m.length - 1];
        if (!last3 || last3.time !== threeMinBucket) {
          candles_3m.push({ time: threeMinBucket, open: priceMid, high: priceMid, low: priceMid, close: priceMid });
          if (candles_3m.length > MAX_CANDLES) candles_3m.shift();
        } else {
          last3.high = Math.max(last3.high, priceMid);
          last3.low  = Math.min(last3.low, priceMid);
          last3.close = priceMid;
        }

        // 5m candle (built directly from ticks)
        let last5 = candles_5m[candles_5m.length - 1];
        if (!last5 || last5.time !== fiveMinBucket) {
          candles_5m.push({ time: fiveMinBucket, open: priceMid, high: priceMid, low: priceMid, close: priceMid });
          if (candles_5m.length > MAX_CANDLES) candles_5m.shift();
        } else {
          last5.high = Math.max(last5.high, priceMid);
          last5.low  = Math.min(last5.low, priceMid);
          last5.close = priceMid;
        }
      }
    } catch (err) {
      console.log('[CANDLE BUILD] error:', err.message || err);
    }


  } catch (err) {
    console.warn('[TICK] Error in handleTick:', err.message || err);
  }
}






// --------------------- SYNC: reconcile broker positions with tracked pairs ---------------------
async function syncOpenPairsWithPositions(positions) {
  const MIN_TRADE_AGE = 5000; // 5 seconds grace period

  try {
    // Normalize broker tickets set
    const brokerTickets = new Set(
      (positions || []).map(p => String(p.positionId || p.ticket || p.id || '')).filter(Boolean)
    );

    // Build ourTickets (by ticket)
    const ourTickets = new Set();

    // 1) tickets from openPairs
    for (const rec of Object.values(openPairs)) {
      if (rec.trades?.PARTIAL?.ticket) ourTickets.add(String(rec.trades.PARTIAL.ticket));
      if (rec.trades?.TRAILING?.ticket) ourTickets.add(String(rec.trades.TRAILING.ticket));
    }



    for (const pos of (positions || [])) {
      const ticket = String(pos.positionId || pos.ticket || pos.id || '');
      if (!ticket) continue;
      const isOurs =
          ourTickets.has(ticket) ||
          ticketOwnershipMap.has(ticket)

      if (isOurs) {
          continue; // do NOT close this trade
      }


      // recentTickets: any very recently placed ticket (ours or manual) — skip
      if (recentTickets.has(ticket)) {
        console.log(`[SYNC] Recently placed trade → NOT external: ${ticket}`);
        continue;
      }


      // existing age heuristics: if still considered external then close
      const posTime = pos.time || pos.updateTime || pos.openingTime || pos.opening_time_utc || null;
      const age = posTime ? (Date.now() - new Date(posTime).getTime()) : Infinity;
      if (age < 3000) {
        console.log(`[SYNC] Ignoring newborn trade ${ticket} (age ${age}ms) — possible mirror`);
        continue;
      }

      console.log(`[SYNC] External/Unknown trade detected → closing ${ticket}`);
      try { await safeClosePosition(ticket); } catch (err) { console.log(`[SYNC] Failed to close ${ticket}:`, err.message); }
    }


    // === RULE: Validate each managed pair and implement WAITING -> adopt-LEG2 logic ===
    for (const [pairId, rec] of Object.entries(openPairs)) {

      // extended grace
      if (rec.openedAt) {
        const ageMs = Date.now() - new Date(rec.openedAt).getTime();
        const GRACE_MS = 5000;
        if (!rec.firstSyncDone) {
          if (ageMs < GRACE_MS) {
            // still in initial grace period -> skip heavy checks
            continue;
          } else {
            rec.firstSyncDone = true;
          }
        }
      }

 



      // If we're WAITING for leg2, try to adopt Exness-provided trade as leg2
      if (rec.state === PAIR_STATE.ENTRY_IN_PROGRESS) {

        if (!rec.trades?.PARTIAL?.ticket) {
          // LEG1 not confirmed yet — cannot proceed to LEG2
          continue;
        }


        // ensure confirm deadline exists (give a slightly larger window)
        if (!rec.confirmDeadlineForLeg2) rec.confirmDeadlineForLeg2 = (rec.entryTimestamp || Date.now()) + 4000;

        // search for candidate positions that could be leg2
        const candidate = (positions || []).find(p => {
          const brokerTicket = String(p.positionId || p.ticket || p.id || '');
          if (!brokerTicket) return false;

          // ❌ Never reuse LEG1 ticket
          if (
            rec.trades?.PARTIAL?.ticket &&
            brokerTicket === String(rec.trades.PARTIAL.ticket)
          ) {
            return false;
          }

          // 🚫 HARD BLOCK: ticket already owned by another pair
          const ownedBy = ticketOwnershipMap.get(brokerTicket);
          if (ownedBy && ownedBy !== rec.pairId) {
            console.log(
              `[ADOPT] Skipping ticket ${brokerTicket} — owned by ${ownedBy}`
            );
            return false;
          }

          // ---------- HARD FILTERS (MANDATORY) ----------

          // Normalize broker side
          const rawSide = String(p.type || p.side || '').toUpperCase();
          const brokerSide = rawSide.includes('SELL')
            ? 'SELL'
            : rawSide.includes('BUY')
            ? 'BUY'
            : rawSide;

          const recSide = String(rec.side).toUpperCase();
          if (brokerSide !== recSide) return false; // 🚫 SIDE MUST MATCH

          // Parse volume robustly
          const volume = Number(
            p.volume ?? p.lots ?? p.original_position_size ?? 0
          );
          const expectedLot = Number(
            rec.lotEach || rec.trades?.PARTIAL?.lot || 0
          );

          if (isNaN(volume) || Math.abs(volume - expectedLot) >= 0.0001) {
            return false; // 🚫 LOT MUST MATCH
          }

          // ---------- SOFT FILTERS (PREFERENCE) ----------

          // Strong ownership preference (only AFTER side+lot match)
          if (ticketOwnershipMap.has(brokerTicket)) {
            return true;
          }

          // Time proximity check
          let openTime = null;
          if (p.openingTime) openTime = new Date(p.openingTime).getTime();
          else if (p.opening_time_utc) openTime = new Date(p.opening_time_utc).getTime();
          else if (p.time) openTime = new Date(p.time).getTime();
          else if (p.updateTime) openTime = new Date(p.updateTime).getTime();

          // If openTime missing, allow cautiously
          if (!openTime) return true;

          const dt = Math.abs(openTime - (rec.entryTimestamp || Date.now()));
          return dt <= 4000;
        });


        if (candidate) {
          const brokerTicket = String(candidate.positionId || candidate.ticket || candidate.id || '');

          if (brokerTicket === String(rec.trades?.PARTIAL?.ticket)) {
            console.log(`[PAIR] Ignoring broker ticket ${brokerTicket} — same as LEG1`);
            continue;
          }


          console.log(`[PAIR] EXNESS-PROVIDED LEG2 adopted for ${pairId} → ${brokerTicket}`);

          rec.trades.TRAILING.ticket = brokerTicket;
          ticketOwnershipMap.set(String(brokerTicket), pairId); // ✅ OWNERSHIP
          transitionPairState(rec, PAIR_STATE.ACTIVE);
          releaseEntryLock('entry-success');


          continue;  // valid inside the rec-loop
        }

        // LEG2 not found — check deadline
        if (Date.now() >= (rec.confirmDeadlineForLeg2 || 0)) {
          // Place LEG2 ourselves to complete the pair

          if (rec.leg2Attempted) {
            console.log(
              `[PAIR] LEG2 fallback already attempted — skipping for ${pairId}`
            );
            continue;
          }

          rec.leg2Attempted = true;

          console.log(
            `[PAIR] LEG2 not found within timeout — placing LEG2 manually for ${pairId}`
          );

          try {
            const placed = await safePlaceMarketOrder(
              rec.side,
              rec.lotEach,
              rec.sl,
              rec.tp,
              2
            );


            if (placed?.ticket) {
              const t = String(placed.ticket);
              rec.trades.TRAILING.ticket = t;
              ticketOwnershipMap.set(t, pairId);
              recentTickets.add(t);
              rec.leg2PlacedAt = Date.now();
              setTimeout(() => recentTickets.delete(t), 15000);
            }

            if (rec.trades?.TRAILING?.ticket) {
              transitionPairState(rec, PAIR_STATE.ACTIVE);
              releaseEntryLock('entry-success');

            } else {
              console.warn(
                `[LEG2] Failed to place LEG2 for ${pairId} — staying in ENTRY_IN_PROGRESS`
              );
              releaseEntryLock('entry-failed');

            }

            
            continue;
          } catch (err) {
            console.error(`[PAIR] Failed to place LEG2 manually for ${pairId}:`, err.message || err);
            releaseEntryLock('entry-failed');
            continue;
          }
        }

        // else still waiting for leg2 — skip further processing for this pair this sync
        continue;
      }


      // If state is ENTRY_COMPLETE or any other, keep backward-compatible validations below
      const partialTicket  = rec.trades?.PARTIAL?.ticket;
      const trailingTicket = rec.trades?.TRAILING?.ticket;

      // PARTIAL missing → only treat missing after grace period (existing behaviour)
      if (partialTicket && !brokerTickets.has(partialTicket)) {
        if (!rec.firstSyncDone) {
          console.log(`[SYNC] PARTIAL missing but still in grace → ignoring (${pairId})`);
        } else {
          console.log(`[SYNC] PARTIAL confirmed missing → force closing ${partialTicket}`);
          try { await safeClosePosition(partialTicket, rec.trades.PARTIAL.lot); } catch (e) {}
          rec.trades.PARTIAL.ticket = null;
          rec.partialClosed = true;
        }
      }

      const LEG2_GRACE_MS = 5000;

      if (
        rec.trades?.TRAILING?.ticket &&
        rec.leg2PlacedAt &&
        Date.now() - rec.leg2PlacedAt < LEG2_GRACE_MS
      ) {
        // Still waiting for broker to reflect LEG2
        continue;
      }


      // TRAILING missing → same rule
      if (trailingTicket && !brokerTickets.has(trailingTicket)) {
        
        if (!rec.firstSyncDone) {
          console.log(`[SYNC] TRAILING missing but still in grace → ignoring (${pairId})`);
        } else {
          console.log(`[SYNC] TRAILING confirmed missing → force closing ${trailingTicket}`);
          try { await safeClosePosition(trailingTicket, rec.trades.TRAILING.lot); } catch (e) {}
          rec.trades.TRAILING.ticket = null;
        }
      }

      // If both tickets gone -> remove pair
      const pExists = rec.trades.PARTIAL.ticket;
      const tExists = rec.trades.TRAILING.ticket;
      if (!pExists && !tExists) {
        if (!rec.firstSyncDone) {
          console.log(`[SYNC] Both tickets missing but still in grace → NOT deleting ${pairId}`);
        } else {
          console.log(`[SYNC] Pair fully closed → removing ${pairId}`);
          // When closing a trade or when it disappears:
          ticketOwnershipMap.delete(String(trailingTicket));
          ticketOwnershipMap.delete(String(partialTicket));

          finalizePair(pairId, "SYNC_CLOSED");
        }
        continue;
      }

    }

  } catch (err) {
    console.error('[SYNC] Error syncing positions:', err.message || err);
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
    api = api || new MetaApi(
      process.env.METAAPI_TOKEN, 
        {
          application: "MetaApi",
          timeout: 4000,
          retryOpts: {
            retries: 0,
            minTimeout: 0,
            maxTimeout: 0
          },
          reconnectOpts: {
            retries: 0
          }
        }
      );

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
    await sendTelegram(`✅ *BOT CONNECTED* — ${SYMBOL}\nBalance: ${accountBalance?.toFixed?.(2) ?? accountBalance}`, { parse_mode: 'MarkdownV2' });

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

    setInterval(async () => {
      try {
        const positions = await safeGetPositions();

        await syncOpenPairsWithPositions(positions);

        checkEntryTimeouts(); // ✅ CALL IT HERE

      } catch (e) {
        console.error('[WATCHDOG] Error:', e.message);
      }
    }, 3000); // every 3 seconds


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
          await sendTelegram(`⚠️ BROKER CONNECTION ALERT — disconnected >30m`, { parse_mode: 'MarkdownV2' });
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
      await sendTelegram(`⚠️ BROKER CONNECTION ALERT — disconnected >30m`, { parse_mode: 'MarkdownV2' });
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
      console.log("[WEBHOOK] ❌ Rejected: Missing 'signal'");
      return res.status(400).json({ ok: false, error: "Missing 'signal' in payload" });
    }

    // Idempotency
    const signalId = payload.signalId ? String(payload.signalId) : null;
    if (signalId && processedSignalIds.has(signalId)) {
      console.log(`[WEBHOOK] 🔁 Duplicate ignored (signalId=${signalId})`);
      return res.status(200).json({ ok: true, message: "Duplicate ignored (idempotent)" });
    }

    // Parse the incoming signal
    const parsed = parseSignalString(payload.signal);

    // ==========================================
    // ZONE APPROVAL HANDLER
    // Format example:
    // signal: "3M ZONE T BUY"
    // approval: true/false
    // ==========================================
    try {
      const z = payload.signal.trim().toUpperCase().split(/\s+/);

      // Expected: [ "3M", "ZONE", "T", "BUY" ]
      if (z.length === 4 && z[1] === "ZONE") {
          const timeframe = z[0];    // "3M" or "5M"
          const type = z[2];         // "T" or "R"
          const side = z[3];         // "BUY" or "SELL"

          const category = `${type}_${side}`;  // T_BUY, T_SELL, R_BUY, R_SELL
          const approval = Boolean(payload.approval);

          if (globalThis.zoneApproval[category]) {
              globalThis.zoneApproval[category][timeframe] = approval;

              return res.status(200).json({
                ok: true,
                updated: { category, timeframe, approval }
              });
          }
      }
    } catch (err) {
      console.log("[ZONE] Error updating zone:", err.message);
    }


    if (!parsed) {
      console.log("[WEBHOOK] ❌ Invalid signal format");
      return res.status(400).json({ ok: false, error: "Invalid signal format" });
    }

    // ================================
    //           ENTRY LOGIC
    // ================================
    if (parsed.kind === "ENTRY") {


      if (isEntryLocked()) {
        console.log('[ENTRY] ⛔ Blocked — entry lock active');
        return;
      }

      acquireEntryLock('entry-processing');



      const category = normalizeCategory(parsed.type, parsed.side);
      const side = parsed.side;
      const now = Date.now();

      console.log(`[ENTRY] Received ENTRY → type=${parsed.type}, side=${side}, category=${category}`);

      // ==========================================
      // APPROVAL ZONE CHECK
      // ==========================================
      const zone3 = globalThis.zoneApproval?.[category]?.["3M"];
      const zone5 = globalThis.zoneApproval?.[category]?.["5M"];

      console.log(`[ENTRY] Zone Check: 3M=${zone3}, 5M=${zone5}`);

      if (!zone3 || !zone5) {
        console.log(`[ENTRY] ⛔ Blocked: Approval zones not satisfied for ${category}`);
        releaseEntryLock('entry-rejected');
        return res.status(403).json({
            ok: false,
            error: `Approval zones not satisfied: 3M=${zone3}, 5M=${zone5}`
        });
      }


      if (!category) {
        console.log("[ENTRY] ❌ Invalid category");
        releaseEntryLock('entry-rejected');
        return res.status(400).json({ ok: false, error: "Invalid category" });
      }

      // ---- CATEGORY LIMIT CHECK ----
      console.log(`[ENTRY] Category Count(${category}) = ${countCategory(category)}, Max=${MAX_PER_CATEGORY}`);

      if (countCategory(category) >= MAX_PER_CATEGORY) {
        console.log(`[ENTRY] ❌ Blocked: Category limit reached for ${category}`);
        releaseEntryLock('entry-rejected');
        return res.status(429).json({ ok: false, error: `Max trades reached for ${category}` });
      }



      // Mark idempotency ID early
      if (signalId) processedSignalIds.add(signalId);

      // ---- LOT SIZING ----
      console.log("[ENTRY] Calculating lot size...");
      const totalLot = await internalLotSizing();
      console.log("[ENTRY] Lot decided:", totalLot);

      // 1️⃣ Get a price reference FIRST
      const priceRef = await safeGetPrice(SYMBOL);
      if (!priceRef) {
        releaseEntryLock('price-unavailable');
        return res.status(500).json({ ok: false, error: 'No price available' });
      }

      const entryRef =
        side === 'BUY' ? priceRef.ask : priceRef.bid;

      // 2️⃣ Calculate SL / TP
      let sltp = calculateDynamicSLTP(side, entryRef);
      let usingFallback = false;

      if (!sltp) {
        // 🚧 INDICATOR WARM-UP FALLBACK
        usingFallback = true;

        if (side === 'BUY') {
          sltp = {
            sl: entryRef - FALLBACK_SL_DISTANCE,
            tp: entryRef + FALLBACK_TP_DISTANCE,
            slDistance: FALLBACK_SL_DISTANCE
          };
        } else {
          sltp = {
            sl: entryRef + FALLBACK_SL_DISTANCE,
            tp: entryRef - FALLBACK_TP_DISTANCE,
            slDistance: FALLBACK_SL_DISTANCE
          };
        }

        console.warn('[WARMUP] Using fallback SL/TP — indicators not ready');
      }


      const { sl, tp, slDistance } = sltp;

      // 3️⃣ Place paired order WITH SL/TP
      const prePair = await placePairedOrder(
        side,
        totalLot,
        sl,
        tp
      );

      
            
      if (!prePair) {
        console.log("[ENTRY] ❌ Order failed → removing signalId & exiting");
        releaseEntryLock('entry-rejected');
        if (signalId) processedSignalIds.delete(signalId);
        return res.status(500).json({ ok: false, error: "Entry failed" });
      }
      
      openPairs[prePair.pairId].sl = sl;
      openPairs[prePair.pairId].tp = tp;
      openPairs[prePair.pairId].slDistance = slDistance;
      openPairs[prePair.pairId].category = category;
      openPairs[prePair.pairId].signalId = signalId || null;

      
      const safeCategory = category.replace(/[^a-zA-Z0-9 ]/g, '');
      const safePairId = md2(prePair.pairId);
      const entryPrice = Number(prePair.entryPrice);
      const slPrice = Number(sl);
      const tpPrice = Number(tp);
      const lot = prePair.totalLot;


      await sendTelegram(
        `${side === 'BUY' ? '🟢 BUY Trade Placed' : '🔴 SELL Trade Placed'}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🆔 Pair: ${safePairId}\n` +
        `📈 Category: ${safeCategory}\n` +
        `💰 Lot: ${lot}\n` +
        `🎯 Entry: ${entryPrice.toFixed(2)}\n` +
        `📊 SL: ${slPrice.toFixed(2)}\n` +
        `🎯 TP: ${tpPrice.toFixed(2)}\n` +
        `📅 Time: ${new Date().toLocaleTimeString()} UTC`,
        { parse_mode: 'MarkdownV2' }
      );





      console.log("[ENTRY] ✔ ENTRY completed\n");

      return res.status(200).json({ ok: true, pair: openPairs[prePair.pairId] });
    }

    // ================================
    //           CLOSE LOGIC (CATEGORY)
    // ================================
    if (parsed.kind === "CLOSE") {

      const category = parsed.category;
      console.log(`[CLOSE] Received CLOSE signal for category=${category}`);

      const toClose = Object.entries(openPairs)
        .filter(([_, rec]) => rec.category === category);

      console.log(`[CLOSE] Found ${toClose.length} pairs to close for ${category}`);

      if (signalId) processedSignalIds.add(signalId);

      for (const [pairId, rec] of toClose) {

        if (rec.state === PAIR_STATE.CLOSED || rec.state === PAIR_STATE.CLOSING) {
          continue;
        }

        transitionPairState(rec, PAIR_STATE.CLOSING, "MANUAL_CLOSE");

        console.log(`[CLOSE] Closing pairId=${pairId} (category=${category})`);

        for (const key of ["PARTIAL", "TRAILING"]) {
          const t = rec.trades[key];
          if (t?.ticket) {
            console.log(`[CLOSE] Attempting to close ${key} → ticket=${t.ticket}`);
            await safeClosePosition(t.ticket, t.lot).catch(e =>
              console.log(`[CLOSE] Failed closing ${key}:`, e.message)
            );
            rec.trades[key].ticket = null;
          }
        }

        finalizePair(pairId, "MANUAL_CLOSE");
        const safeCategory = category.replace(/[^a-zA-Z0-9 ]/g, '');
        const safePairId = md2(pairId);

        await sendTelegram(
          `🔴 *CATEGORY CLOSE*\n` +
          `Category: ${safeCategory}\n` +
          `Pair: ${safePairId}`,
          { parse_mode: "MarkdownV2" }
        );

        console.log(`[CLOSE] ✔ Pair closed: ${pairId}`);
      }

      return res.status(200).json({
        ok: true,
        category,
        closed: toClose.length
      });
    }


    console.log("[WEBHOOK] ❌ Unknown signal type");
    return res.status(400).json({ ok: false, error: "Unknown signal" });

  } catch (err) {
    console.error("[WEBHOOK] ❌ Unhandled Error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}



// ---- START EXPRESS SERVER ----
function startWebhookServer() {
  const app = express();
  app.use(bodyParser.json());

  app.post("/webhook", handleTradingViewSignal);
  app.get("/_health", (_, res) => res.send("OK"));

  app.listen(EXNESS_PORT, () =>
    console.log(`[WEBHOOK] Ready on port ${EXNESS_PORT}`)
  );
}

startWebhookServer();

process.on("uncaughtException", err => {
  console.error("[FATAL] Uncaught Exception:", err.stack || err);
  process.exit(1);
});

process.on("unhandledRejection", err => {
  console.error("[FATAL] Unhandled Rejection:", err);
  process.exit(1);
});

 

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
