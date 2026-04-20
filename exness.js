// NOTE: Test on demo before running live

require('dotenv').config()

const MetaApi = require('metaapi.cloud-sdk').default;
// ---- METAAPI HOTFIX: count & skip corrupted broker history records ----
const MemoryHistoryStorage =
  require('metaapi.cloud-sdk/dist/metaApi/memoryHistoryStorage').default;

const _origAddDeal = MemoryHistoryStorage.prototype._addDeal;
const _origAddHistoryOrder = MemoryHistoryStorage.prototype._addHistoryOrder;

// global counter (lives for process lifetime)
let corruptedDealCount = 0;

MemoryHistoryStorage.prototype._addDeal = async function (deal, existing) {
  try {
    // Check if time is a valid Date object to prevent AVL tree insert crashes
    if (deal && deal.time && typeof deal.time.getTime !== 'function') {
      throw new Error("Invalid time format");
    }
    this._getDealKey(deal); // Can it throw? Throwing here prevents mutation
    return await _origAddDeal.call(this, deal, existing);
  } catch (e) {
    corruptedDealCount++;
    return; // silently skip
  }
};

MemoryHistoryStorage.prototype._addHistoryOrder = async function (historyOrder, existing) {
  try {
    if (historyOrder && historyOrder.doneTime && typeof historyOrder.doneTime.getTime !== 'function') {
      throw new Error("Invalid time format");
    }
    this._getHistoryOrderKey(historyOrder);
    return await _origAddHistoryOrder.call(this, historyOrder, existing);
  } catch (e) {
    corruptedDealCount++;
    return; // silently skip
  }
};

// optional: expose a safe getter if you want to report it later
global.getCorruptedDealCount = () => corruptedDealCount;

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const RAW_ORDERS_LOG = '/tmp/raw_order_responses.log';
const { connectDB } = require("./db");
const { loadOpenPairs, saveTrade } = require("./models");
const { initTelegramBot, getBot } = require("./telegram");
const { initSymbol } = require('./src/core/symbolRegistry');
const { updatePrice } = require('./src/core/symbolRegistry');
const { getContext } = require('./src/core/symbolRegistry');
const { strategyEngine } = require('./src/strategy/strategyEngine');




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

initSymbol(SYMBOL);

const MIN_LOT = 0.01; // minimum lot size per broker
// ---------------- LOT SIZING ----------------
let FIXED_LOT = 0.02;   // default lot size for ALL trades



// global map to track idempotency
const ticketOwnershipMap = new Map(); // ticket -> pairId


async function sendTelegram(message, options = {}) {
  try {
    const bot = getBot();
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return;

    const safeMessage = message.replace(/([\[\]\(\)~`>#+\-=|{}\.!])/g, '\\$1');
    await bot.sendMessage(chatId, safeMessage, options);
  } catch (e) {
    console.warn("❌ Telegram send failed:", e.message);
  }
}



function md2(text) {
  return text
    // escape all MarkdownV2 reserved characters
    .replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
    // extra safety for hyphens (Telegram sometimes breaks even inside ranges)
    .replace(/-/g, '\\-');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}




// --------------------- STATE ---------------------
let api, account, connection;
let accountBalance = 0;
let streamingInitializing = false;


// --- INTERNAL CANDLES (for ATR & other features) ---
let candles_1m = [];   // array of {time, open, high, low, close}
let candles_3m = [];   // array of {time, open, high, low, close}
let candles_5m = [];   // array of {time, open, high, low, close}
let candles_15m = [];
const MAX_CANDLES = 500; // keep last N candles

// ========================
// STRATEGY STATE
// ========================
const STRATEGY_STATE = {
  trendBias: "NONE",        // BUY | SELL | NONE
  marketRegime: "DEAD",     // ACTIVE | DEAD
  setupState: "IDLE",       // IDLE | PULLBACK | CONFIRMED
  lastUpdate: 0
};


// ATR / volatility config (tweakable)
const ATR_PERIOD = 14;                // ATR period measured in M5 candles
const ATR_TRIGGER_MULTIPLIER = 1.5;   // used to compute dynamic trigger = ATR * multiplier



let latestPrice = null;   // { bid, ask, timestamp }
let lastTradeMonitorRun = 0;
let lastStrategyCandle = 0;
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



let coldStartMode = true;
let coldStartStartedAt = Date.now();
const COLD_START_DURATION = 60 * 60 * 1000; // 1 hour






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

//Candle Agrregation and Indicators

function calculateEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
  
}

function calculateSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateStdDev(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = calculateSMA(values, period);
  const variance =
    slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
  return Math.sqrt(variance);
}

function calculateBollingerBands(values, period = 20, mult = 2) {
  const mid = calculateSMA(values, period);
  const std = calculateStdDev(values, period);
  if (mid == null || std == null) return null;

  return {
    upper: mid + mult * std,
    lower: mid - mult * std,
    middle: mid,
    width: (2 * mult * std) / mid // normalized BB width
  };
}

function calculateStochastic(candles, period = 14) {
  if (candles.length < period) return null;

  const slice = candles.slice(-period);
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);

  const highestHigh = Math.max(...highs);
  const lowestLow = Math.min(...lows);
  const lastClose = slice[slice.length - 1].close;

  if (highestHigh === lowestLow) return null;

  return ((lastClose - lowestLow) / (highestHigh - lowestLow)) * 100;
}




// Preload recent M5 candles on startup for ATR and regime evaluation

async function preloadHistoricalM5() {
  try {
    console.log("[HISTORY] Loading M5 history...");

    const history = await account.getHistoricalCandles(
      SYMBOL,
      '5m',
      null,
      700
    );

    if (!history?.length) {
      console.warn("[HISTORY] No M5 candles returned");
      return;
    }


    const map = new Map();

    for (const c of history) {
      const rawTime = new Date(c.time).getTime();

      // 🔒 Same bucket logic as tick handler
      const bucket = Math.floor(rawTime / 300000) * 300000;

      map.set(bucket, {
        time: bucket,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      });
    }

    candles_5m = Array.from(map.values())
      .sort((a, b) => a.time - b.time);

    console.log(`[HISTORY] Loaded ${candles_5m.length} aligned M5 candles`);

  } catch (err) {
    console.error("[HISTORY] Failed to preload M5:", err.message || err);
  }
}

function bootstrapM15FromM5() {
  candles_15m = [];

  for (const c of candles_5m) {
    const bucket = Math.floor(c.time / 900000) * 900000;

    let last = candles_15m[candles_15m.length - 1];

    if (!last || last.time !== bucket) {
      candles_15m.push({
        time: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      });
    } else {
      last.high = Math.max(last.high, c.high);
      last.low  = Math.min(last.low, c.low);
      last.close = c.close;
    }
  }

  console.log(`[HISTORY] Bootstrapped ${candles_15m.length} M15 candles`);
}


async function backfillHistoricalData() {
  const history = await account.getHistoricalCandles(SYMBOL, '5m', null, 700);
  if (!history?.length) return;

  const existingTimes = new Set(candles_5m.map(c => c.time));

  for (const c of history) {
    const bucket = Math.floor(new Date(c.time).getTime() / 300000) * 300000;

    if (!existingTimes.has(bucket)) {
      candles_5m.push({
        time: bucket,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      });
    }
  }

  candles_5m.sort((a, b) => a.time - b.time);

  bootstrapM15FromM5();
}




//Transition and Trade Management Helpers

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

async function transitionPairState(rec, nextState, reason = null) {
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
  const { updatePair } = require("./models");
  await updatePair(rec.pairId, {
    state: rec.state,
    closingReason: rec.closingReason ?? null
  });


  return true;
}

function buildTradeSnapshot(rec) {
  // --- normalize openedAt safely ---
  const openedAt =
    rec.openedAt instanceof Date
      ? rec.openedAt
      : new Date(rec.openedAt);

  if (isNaN(openedAt.getTime())) {
    throw new Error(`[DATA] Invalid openedAt for pair ${rec.pairId}: ${rec.openedAt}`);
  }

  const pnl = rec.realizedPnL ?? 0;

  return {
    tradeId: rec.pairId,
    accountId: rec.accountId,
    userId: rec.userId,
    side: rec.side,
    category: rec.category,
    symbol: rec.symbol,
    entryPrice: rec.entryPrice,
    exitPrice: rec.exitPrice,
    lot: rec.totalLot,
    grossPnL: pnl,
    netPnL: pnl,
    openedAt,
    closedAt: new Date(),
    durationSec: Math.floor((Date.now() - openedAt.getTime()) / 1000),
    result: pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "BE"
  };
}


async function finalizePair(pairId, reason) {
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

  const { finalizePairDB } = require("./models");
  await finalizePairDB(pairId, reason);
  try {
    const snapshot = buildTradeSnapshot(rec);
    await saveTrade(snapshot);
  } catch (err) {
    console.error(
      `[FINALIZE] Snapshot/save failed for ${pairId}:`,
      err.message || err
    );
  }
  // always cleanup local state
  delete openPairs[pairId];
  notifyTradeClosed();


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

async function canPlaceTrade(accountId) {
  const { getAccountById, getUserByUserId } = require("./models");

  const account = await getAccountById(accountId);
  if (!account) return false;

  const user = await getUserByUserId(account.userId);
  if (!user) return false;

  return (
    user.enabled === true &&
    account.enabled === true &&
    account.userPaused === false
  );
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
      openedAt: new Date(),
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

async function processStrategyEntry(side, score = null) {

  if (isEntryLocked()) {
    console.log('[ENTRY] ⛔ Blocked — entry lock active');
    return;
  }

  acquireEntryLock('strategy-entry');

  try {

    const accountId = process.env.METAAPI_ACCOUNT_ID;

    // const allowed = await canPlaceTrade(accountId);

    // if (!allowed) {
    //   console.log("[ENTRY] ⛔ Blocked by account/user state");
    //   releaseEntryLock('entry-rejected');
    //   return;
    // }

    // ---- LOT SIZING ----
    const totalLot = await internalLotSizing();

    // ---- PRICE REF ----
    const priceRef = await safeGetPrice(SYMBOL);

    if (!priceRef) {
      releaseEntryLock('price-unavailable');
      return;
    }

    const entryRef =
      side === 'BUY'
        ? priceRef.ask
        : priceRef.bid;

    // ---- SL / TP ----
    let sltp = calculateDynamicSLTP(side, entryRef);

    if (!sltp) {

      console.warn('[WARMUP] Using fallback SL/TP');

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
    }

    const { sl, tp, slDistance } = sltp;

    // ---- PLACE ORDER ----
    const prePair = await placePairedOrder(
      side,
      totalLot,
      sl,
      tp
    );

    if (!prePair) {
      console.log("[ENTRY] ❌ Order failed");
      releaseEntryLock('entry-failed');
      return;
    }

    openPairs[prePair.pairId].sl = sl;
    openPairs[prePair.pairId].tp = tp;
    openPairs[prePair.pairId].slDistance = slDistance;

    // ---- SAVE TO DB ----
    const { savePair } = require("./models");
    await savePair(openPairs[prePair.pairId]);

    // ---- TELEGRAM ALERT ----
    const safePairId = md2(prePair.pairId);
    const entryPrice = Number(prePair.entryPrice);
    const slPrice = Number(sl);
    const tpPrice = Number(tp);
    const lot = prePair.totalLot;

    const scoreText = score !== null
      ? `📊 Score: ${score}\n`
      : '';

    await sendTelegram(
      `${side === 'BUY' ? '🟢 BUY Trade Placed' : '🔴 SELL Trade Placed'}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `${scoreText}` +
      `🆔 Pair: ${safePairId}\n` +
      `💰 Lot: ${lot}\n` +
      `🎯 Entry: ${entryPrice.toFixed(2)}\n` +
      `📊 SL: ${slPrice.toFixed(2)}\n` +
      `🎯 TP: ${tpPrice.toFixed(2)}\n` +
      `📅 Time: ${new Date().toLocaleTimeString()} UTC`,
      { parse_mode: 'MarkdownV2' }
    );

    console.log("[ENTRY] ✔ STRATEGY ENTRY completed");

  } catch (err) {

    console.error("[ENTRY] ❌ Strategy entry error:", err.message);

    releaseEntryLock('entry-error');
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
    const tickTime = new Date(tick.time).getTime();
    const ctx = getContext(SYMBOL);
    updatePrice(SYMBOL, tickBid, tickAsk, tickTime);

    


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
      const nowMs = tickTime;
      const minuteBucket = Math.floor(nowMs / 60000) * 60000; // 1m bucket (60000ms)
      const threeMinBucket = Math.floor(minuteBucket / 180000) * 180000; // 3m bucket (180000ms)
      const fiveMinBucket = Math.floor(minuteBucket / 300000) * 300000;  // 5m bucket (300000ms)
      const fifteenMinBucket = Math.floor(minuteBucket / 900000) * 900000; // 15m bucket (900000ms)

      const priceMid = (tick.bid != null && tick.ask != null) ? ((tick.bid + tick.ask) / 2) : (tick.bid ?? tick.ask ?? null);

      if (priceMid != null) {
        // 1m candle
        let last1 = candles_1m[candles_1m.length - 1];
        if (!last1 || last1.time !== minuteBucket) {
          candles_1m.push({ time: minuteBucket, open: priceMid, high: priceMid, low: priceMid, close: priceMid });
          if (candles_1m.length > MAX_CANDLES) candles_1m.shift();
          ctx.candles.m1 = candles_1m;
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
          ctx.candles.m5 = candles_5m;
        } else {
          last5.high = Math.max(last5.high, priceMid);
          last5.low  = Math.min(last5.low, priceMid);
          last5.close = priceMid;
        }

        // 15m candle (built directly from ticks)
        let last15 = candles_15m[candles_15m.length - 1];
        if (!last15 || last15.time !== fifteenMinBucket) {
          candles_15m.push({
            time: fifteenMinBucket,
            open: priceMid,
            high: priceMid,
            low: priceMid,
            close: priceMid
          });
          if (candles_15m.length > MAX_CANDLES) candles_15m.shift();
          ctx.candles.m15 = candles_15m;
        } else {
          last15.high = Math.max(last15.high, priceMid);
          last15.low  = Math.min(last15.low, priceMid);
          last15.close = priceMid;
        }
        
        const m5Closes = candles_5m.map(c => c.close);
        const m15Closes = candles_15m.map(c => c.close);

        ctx.indicators.rsi = calculateRSI(m5Closes, 14);
        ctx.indicators.stochastic = calculateStochastic(candles_5m, 14);

        ctx.indicators.ema50 = calculateEMA(m15Closes, 50);
        ctx.indicators.ema200 = calculateEMA(m15Closes, 200);

        ctx.indicators.bollinger = calculateBollingerBands(m5Closes, 20, 2);

        ctx.indicators.atr = computeATR_M5();
        
        if (ctx.indicators.prevStochastic != null) {
        ctx.indicators.stochasticDelta =
          ctx.indicators.stochastic - ctx.indicators.prevStochastic;
        }

        ctx.indicators.prevStochastic = ctx.indicators.stochastic;
        

        const lastM5 = candles_5m[candles_5m.length - 1];

        if (lastM5 && lastM5.time !== lastStrategyCandle) {

          lastStrategyCandle = lastM5.time;

          if (ctx) {
            ctx.price = latestPrice; // 🔴 ADD THIS
            const result = strategyEngine(ctx);

            if (result?.action === "ENTER") {
              await processStrategyEntry(result.signal, result.score);
            }
          }
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
  await initTelegramBot();


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

    const { upsertDeployedAccount } = require("./models");

    await upsertDeployedAccount({
      accountId: account.id,   // ← THIS IS THE FIX
      broker: "EXNESS",
      symbol: "XAUUSDm"
    });


    console.log(`[DB] Account registered as DEPLOYED → ${account.id}`);


    // ------------- create streaming connection and wait for synchronization
    connection = account.getStreamingConnection();


    // ---- SYNC GUARD (ADD HERE) ----
    if (connection.synchronizing || connection.synchronized) {

      console.warn('[METAAPI] Streaming connection already synchronizing/synchronized — skipping connect()');

    } else {

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
    }


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

    console.log("[COLD START] Live build mode activated (no preload)");

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

    setInterval(async () => {
      if (coldStartMode && Date.now() - coldStartStartedAt >= COLD_START_DURATION) {
        console.log("[COLD START] 1hr completed → Fetching historical backfill");

        await backfillHistoricalData();

        coldStartMode = false;
        console.log("[COLD START] Backfill done → Strategy Activated");
      }
    }, 10_000);

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
        // ---- SYNC GUARD (ADD HERE TOO) ----
        if (connection.synchronizing || connection.synchronized) {
          console.warn('[METAAPI] Reconnect skipped — already synchronizing/synchronized');
          return;
        }

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




// ---- START EXPRESS SERVER ----
function startWebhookServer() {
  const app = express();
  app.use(bodyParser.json());

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
