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
const MAX_PER_CATEGORY = 1;
// 15-minute cooldown between trades of the same side (BUY or SELL)
const SIDE_COOLDOWN_MS = 15 * 60 * 1000;
const lastEntryTime = { BUY: 0, SELL: 0 };



// --------------------- CONFIG ---------------------
const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
const SYMBOL = process.env.SYMBOL || "XAUUSDm"; // change to XAUUSDm/GOLD/etc. per broker
const MIN_LOT = 0.01; // minimum lot size per broker
// ---------------- LOT SIZING ----------------
let FIXED_LOT = 0.04;   // default lot size for ALL trades




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
const ATR_LOW_THRESHOLD = 2.5;        // ATR < this => "low" volatility (tune for your symbol)
const ATR_TRIGGER_MULTIPLIER = 1.5;   // used to compute dynamic trigger = ATR * multiplier
const TRAIL_STEP_LOW = 5;             // 5 points when low vol
const TRAIL_STEP_HIGH = 10;           // 10 points when mid/high vol



let latestPrice = null;   // { bid, ask, timestamp }
let lastTradeMonitorRun = 0;

const botStartTime = Date.now();
let lastTickPrice = null;
let stagnantTickCount = 0;
let stagnantSince = null;
let marketFrozen = false;
let openPairs = {}; // ticket -> metadata
let entryProcessingLock = false;


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
  const SL_DISTANCE = 8; // points or dollars

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

    // NOTE: SL_DISTANCE and HALF_DISTANCE kept as before (fallback / checkpoint)
    const SL_DISTANCE = 8;      // initial SL distance from entry (points/dollars)
    const HALF_DISTANCE = 5; // first checkpoint

    for (const [pairId, rec] of Object.entries(openPairs)) {

      // --- Grace period: do NOT run missing-ticket or trailing logic for first 5s ---
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

        if (trailingRec?.ticket && !openTickets.has(trailingRec.ticket)) {
          console.log(`[PAIR] Trailing ticket ${trailingRec.ticket} missing for ${pairId} — marking trailing null.`);
          rec.trades.TRAILING.ticket = null;
        }
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

          if (rec.tightSLMode) {

          // ------------------------------
          // TIGHT-SL MODE: BUY SIDE
          // ------------------------------
          if (side === 'BUY') {

            // CHECKPOINT 1 → +5 → partial close ONLY
            if (current >= entry + HALF_DISTANCE) {
              if (partialRec?.ticket) {
                await safeClosePosition(partialRec.ticket, partialRec.lot);
                rec.partialClosed = true;
                rec.trades.PARTIAL.ticket = null;

                console.log(`[PAIR][${pairId}] (TIGHT MODE BUY) Partial closed at +5 (SL unchanged).`);
                const safeId = md2(pairId);
                await sendTelegram(
                  `🟠 *PARTIAL CLOSED (TIGHT MODE)*\n${safeId}\nSide: BUY\nSL unchanged`,
                  { parse_mode: 'MarkdownV2' }
                );
              }
            }

            // CHECKPOINT 2 → +8 → break-even
            if (current >= entry + SL_DISTANCE) {
              if (!rec.breakEvenActive) {
                rec.breakEvenActive = true;
                rec.internalSL = entry;

                console.log(`[PAIR][${pairId}] (TIGHT MODE BUY) Break-even at +8.`);
                const safeId = md2(pairId);
                await sendTelegram(
                  `🟢 *BREAK-EVEN (TIGHT MODE)*\n${safeId}\nSide: BUY\nSL → ${entry}`,
                  { parse_mode: 'MarkdownV2' }
                );
              }
            }
          }



          // ------------------------------
          // TIGHT-SL MODE: SELL SIDE
          // ------------------------------
          if (side === 'SELL') {

            // CHECKPOINT 1 → -5 → partial close ONLY
            if (current <= entry - HALF_DISTANCE) {
              if (partialRec?.ticket) {
                await safeClosePosition(partialRec.ticket, partialRec.lot);
                rec.partialClosed = true;
                rec.trades.PARTIAL.ticket = null;

                console.log(`[PAIR][${pairId}] (TIGHT MODE SELL) Partial closed at -5 (SL unchanged).`);
                const safeId = md2(pairId);
                await sendTelegram(
                  `🟠 *PARTIAL CLOSED (TIGHT MODE)*\n${safeId}\nSide: SELL\nSL unchanged`,
                  { parse_mode: 'MarkdownV2' }
                );
              }
            }

            // CHECKPOINT 2 → -8 → break-even
            if (current <= entry - SL_DISTANCE) {
              if (!rec.breakEvenActive) {
                rec.breakEvenActive = true;
                rec.internalSL = entry;

                console.log(`[PAIR][${pairId}] (TIGHT MODE SELL) Break-even at -8.`);
                const safeId = md2(pairId);
                await sendTelegram(
                  `🟢 *BREAK-EVEN (TIGHT MODE)*\n${safeId}\nSide: SELL\nSL → ${entry}`,
                  { parse_mode: 'MarkdownV2' }
                );
              }
            }
          }

        }else{
            if (side === 'BUY') {
                // checkpoint 1: when price reaches entry + HALF_DISTANCE, move SL to entry - HALF_DISTANCE
                if (current >= entry + HALF_DISTANCE) {
                  const desiredSL = entry - HALF_DISTANCE;
                  if (rec.internalSL < desiredSL) { // move SL forward (less loss)
                    rec.internalSL = desiredSL;
                    console.log(`[PAIR][${pairId}] CHECKPOINT1 reached — SL moved to ${rec.internalSL.toFixed(2)}`);
                    const safePairId = md2(pairId);

                    await sendTelegram(`🔷 *Checkpoint 1* — ${safePairId}\nSide: BUY\nSL moved → ${rec.internalSL.toFixed(2)}`, { parse_mode: 'MarkdownV2' });
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
                      const safePairId = md2(pairId);
                      await sendTelegram(
                        `🟠 *PARTIAL CLOSED + BREAK-EVEN SET*\nPair: ${safePairId}\nSide: BUY\nPartial lot: ${partialRec.lot}\nBE (internal SL): ${rec.internalSL.toFixed(2)}`,
                        { parse_mode: 'MarkdownV2' }
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
                    const safePairId = md2(pairId);
                    await sendTelegram(`🔷 *Checkpoint 1* — ${safePairId}\nSide: SELL\nSL moved → ${rec.internalSL.toFixed(2)}`, { parse_mode: 'MarkdownV2' });
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
                      const safePairId = md2(pairId);
                      await sendTelegram(
                        `🟠 *PARTIAL CLOSED + BREAK-EVEN SET*\nPair: ${safePairId}\nSide: SELL\nPartial lot: ${partialRec.lot}\nBE (internal SL): ${rec.internalSL.toFixed(2)}`,
                        { parse_mode: 'MarkdownV2' }
                      );
                      const newBal = await safeGetAccountBalance();
                      if (newBal && newBal !== accountBalance) accountBalance = newBal;
                    } catch (err) {
                      console.warn(`[PAIR] Partial close failed for ${pairId}:`, err.message || err);
                    }
                  }
                }
              }
        }

        
      } // end pre-partial

      // --- POST-PARTIAL / TRAILING logic (only after BE or partialClosed) ---
      // If we have activated BE or partialClosed, enable ATR-driven 5/10 step trailing
      if (rec.partialClosed || rec.breakEvenActive) {
        // compute ATR from 5m candles
        const atr = (typeof computeATR_M5 === 'function') ? computeATR_M5(ATR_PERIOD) : 0;

        // // classify volatility
        // const isLowVol = (atr > 0 && atr < ATR_LOW_THRESHOLD) || (atr === 0); // treat missing ATR as "low" conservatively

        // // select fixed step based on volatility class
        // const TRAIL_STEP = isLowVol ? TRAIL_STEP_LOW : TRAIL_STEP_HIGH;
        const TRAIL_STEP = 5;


        // dynamic trigger: require price to move beyond SL by either ATR*mult or TRAIL_STEP * 1.5 (stable floor)
        const dynamicTrigger = Math.max((atr * ATR_TRIGGER_MULTIPLIER), (TRAIL_STEP * 1.5));
        const TRAIL_TRIGGER = Math.max(dynamicTrigger, 1); // safety floor to avoid 0 triggers

        // debug logging (optional)
        
        if (side === 'BUY') {
          // distance from current internalSL to current price
          const distanceFromSL = current - rec.internalSL;

          // Only advance if price moved beyond TRAIL_TRIGGER
          if (distanceFromSL > TRAIL_TRIGGER) {
            const newSL = current - TRAIL_STEP;

            // only move SL forward (never backward)
            if (newSL > rec.internalSL) {
              // Respect BE: do not move SL below BE when BE is active
              const beLimit = rec.breakEvenActive ? rec.entryPrice : -Infinity;
              const adjustedNewSL = Math.max(newSL, beLimit); // never set SL below BE entryPrice for BUY

              const oldSL = rec.internalSL;
              rec.internalSL = adjustedNewSL;
              const safePairId = md2(pairId);
              console.log(`[PAIR][${pairId}] TRAIL advanced (M5-ATR) from ${oldSL.toFixed(2)} -> ${rec.internalSL.toFixed(2)} (price=${current.toFixed(2)}, step=${TRAIL_STEP})`);
              await sendTelegram(
                `➡️ *TRAIL ADVANCED (M5-ATR)*\nPair: ${safePairId}\nSide: BUY\nOld SL: ${oldSL.toFixed(2)}\nNew SL: ${rec.internalSL.toFixed(2)}\nPrice: ${current.toFixed(2)}\nM5 ATR: ${atr.toFixed(4)}`,
                { parse_mode: 'MarkdownV2' }
              );
            }
          }
        } else {
          // SELL side
          const distanceFromSL = rec.internalSL - current;

          if (distanceFromSL > TRAIL_TRIGGER) {
            const newSL = current + TRAIL_STEP;

            if (newSL < rec.internalSL) {
              // Respect BE: do not move SL above BE when BE is active (for SELL)
              const beLimit = rec.breakEvenActive ? rec.entryPrice : Infinity;
              const adjustedNewSL = Math.min(newSL, beLimit);

              const oldSL = rec.internalSL;
              rec.internalSL = adjustedNewSL;
              const safePairId = md2(pairId);
              console.log(`[PAIR][${pairId}] TRAIL advanced (M5-ATR) from ${oldSL.toFixed(2)} -> ${rec.internalSL.toFixed(2)} (price=${current.toFixed(2)}, step=${TRAIL_STEP})`);
              await sendTelegram(
                `➡️ *TRAIL ADVANCED (M5-ATR)*\nPair: ${safePairId}\nSide: SELL\nOld SL: ${oldSL.toFixed(2)}\nNew SL: ${rec.internalSL.toFixed(2)}\nPrice: ${current.toFixed(2)}\nM5 ATR: ${atr.toFixed(4)}`,
                { parse_mode: 'MarkdownV2' }
              );
            }
          }
        }
      } // end trailing

      // --- HARD STOP-LOSS / TRAILING-SL HIT CHECK ---
      // No buffer — clean raw SL comparison
      const effectiveSL = rec.internalSL ?? rec.sl;

      // Detect hit (BUY/SELL opposite as usual)
      const slHit =
        (side === 'BUY'  && current <= effectiveSL) ||
        (side === 'SELL' && current >= effectiveSL);

      if (slHit) {

        // Determine if the SL was hit in profit or loss
        const profitClosure =
          (side === 'BUY'  && effectiveSL > rec.entryPrice) ||
          (side === 'SELL' && effectiveSL < rec.entryPrice);

        const alertType = profitClosure
          ? "🟢 *PROFIT — TRAILING SL CLOSED*"
          : "⛔ *STOP-LOSS HIT — LOSS CLOSED*";

        console.log(`[PAIR] ${alertType} for ${pairId}`);

        // Close both legs
        for (const key of ['PARTIAL', 'TRAILING']) {
          const t = rec.trades[key];
          if (t?.ticket) {
            try {
              await safeClosePosition(t.ticket, t.lot);
              rec.trades[key].ticket = null;
            } catch (err) {
              console.warn(`[PAIR] Failed to close ${key} leg for ${pairId}:`, err.message);
            }
          }
        }

        rec.awaitingFinalClose = true;
        const safePairId = md2(pairId);

        await sendTelegram(
          `${alertType}\n━━━━━━━━━━━━━━━\n🎫 *Pair:* ${safePairId}\n📈 *Side:* ${side}\nSL: ${effectiveSL.toFixed(2)}\nEntry: ${rec.entryPrice.toFixed(2)}\n🕒 ${new Date().toLocaleTimeString()}`,
          { parse_mode: "MarkdownV2" }
        );

        const newBal = await safeGetAccountBalance();
        if (newBal && newBal !== accountBalance) accountBalance = newBal;

        continue;
      }


      // --- If both trade tickets are gone, cleanup pair ---
      if (!rec.trades.PARTIAL.ticket && !rec.trades.TRAILING.ticket) {
        rec.awaitingFinalClose = true;

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
  
  const MIN_TRADE_AGE = 5000; // 5 seconds grace period

  try {

    // Normalize broker tickets
    const brokerTickets = new Set(
      (positions || [])
        .map(p => p.positionId || p.ticket || p.id)
        .filter(Boolean)
    );

    // ============================================
    // RULE 1: Force-close any external trades
    // ============================================
    const ourTickets = new Set();

    for (const rec of Object.values(openPairs)) {
      if (rec.trades?.PARTIAL?.ticket) ourTickets.add(rec.trades.PARTIAL.ticket);
      if (rec.trades?.TRAILING?.ticket) ourTickets.add(rec.trades.TRAILING.ticket);
    }

    for (const pos of (positions || [])) {
      const ticket = pos.positionId || pos.ticket || pos.id;
      if (!ourTickets.has(ticket)) {
        console.log(`[SYNC] External/Unknown trade detected → closing ${ticket}`);
        try {
          await safeClosePosition(ticket);
        } catch (err) {
          console.log(`[SYNC] Failed to close external trade ${ticket}:`, err.message);
        }
      }
    }

    // ============================================
    // RULE 2: Validate each managed pair
    // ============================================
    for (const [pairId, rec] of Object.entries(openPairs)) {

      // === GRACE PERIOD: avoid false "missing ticket" for newly opened trades ===
      if (rec.openedAt) {
        const ageMs = Date.now() - new Date(rec.openedAt).getTime();
        if (ageMs < 5000) {  // 5 seconds
          // Skip sync checks for this pair
          console.log(`[SYNC] Skipping ${pairId} (trade too new: ${ageMs}ms)`);
          continue;
        }
      }

      const partialTicket  = rec.trades?.PARTIAL?.ticket;
      const trailingTicket = rec.trades?.TRAILING?.ticket;

      // PARTIAL missing → only treat as missing after grace period
      if (partialTicket && !brokerTickets.has(partialTicket)) {
        console.log(`[SYNC] PARTIAL missing after grace → force closing ${partialTicket}`);
        try { await safeClosePosition(partialTicket, rec.trades.PARTIAL.lot); } catch {}
        rec.trades.PARTIAL.ticket = null;
        rec.partialClosed = true;
      }

      // TRAILING missing → same rule
      if (trailingTicket && !brokerTickets.has(trailingTicket)) {
        console.log(`[SYNC] TRAILING missing after grace → force closing ${trailingTicket}`);
        try { await safeClosePosition(trailingTicket, rec.trades.TRAILING.lot); } catch {}
        rec.trades.TRAILING.ticket = null;
      }


      // ============================================
      // RULE 3: If both legs gone → remove the pair
      // ============================================
      const pExists = rec.trades.PARTIAL.ticket;
      const tExists = rec.trades.TRAILING.ticket;

      // Ensure deletion also honors grace period
      if (!pExists && !tExists) {
        const ageMs = Date.now() - new Date(rec.openedAt).getTime();
        if (ageMs > 5000) {
          console.log(`[SYNC] Pair fully closed → removing ${pairId}`);
          delete openPairs[pairId];
        } else {
          console.log(`[SYNC] Not deleting ${pairId} (both tickets missing but trade too new: ${ageMs}ms)`);
        }
        continue;
      }


      // ============================================
      // RULE 4: REFRESH ENTRY PRICE if broker has it
      // ============================================
      try {
        const liveTicket =
          rec.trades.TRAILING?.ticket ||
          rec.trades.PARTIAL?.ticket;

        if (liveTicket) {
          const posObj = (positions || []).find(p =>
            (p.positionId === liveTicket) ||
            (p.ticket === liveTicket) ||
            (p.id === liveTicket)
          );

          if (posObj && posObj.price && posObj.price > 0) {
            const oldEntry = rec.entryPrice;
            const newEntry = posObj.price;

            if (oldEntry !== newEntry) {
              rec.entryPrice = newEntry;

              if (!rec.breakEvenActive && !rec.partialClosed) {
                const SL_DISTANCE = 8;

                rec.internalSL = rec.side === "BUY"
                  ? newEntry - SL_DISTANCE
                  : newEntry + SL_DISTANCE;
              }

              console.log(
                `[ENTRY REFRESH] ${pairId} entry updated: ${oldEntry} → ${newEntry}, internalSL=${rec.internalSL}`
              );
            }
          }
        }
      } catch (err) {
        console.log(`[ENTRY REFRESH ERROR] ${pairId}`, err.message);
      }
    }

  } catch (err) {
    console.error('[SYNC] Error syncing positions:', err.message || err);
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

      // 3️⃣ Refresh ENTRY PRICE & adjust internal SL baseline
      try {
        // Choose any existing leg to reference (prefer trailing leg)
        const legTicket =
          rec.trades?.TRAILING?.ticket ||
          rec.trades?.PARTIAL?.ticket;

        if (legTicket) {
          const posObj = (positions || []).find(p =>
            p.positionId === legTicket ||
            p.ticket === legTicket ||
            p.id === legTicket
          );

          if (posObj && posObj.price && posObj.price > 0) {
            const oldEntry = rec.entryPrice;
            const newEntry = posObj.price;

            if (oldEntry !== newEntry) {
              rec.entryPrice = newEntry;

              // Only adjust internal SL baseline if BE is not yet active
              // and partial is not yet closed
              if (!rec.breakEvenActive && !rec.partialClosed) {
                const SL_DISTANCE = 8; // must match your default

                if (rec.side === "BUY") {
                  rec.internalSL = newEntry - SL_DISTANCE;
                } else {
                  rec.internalSL = newEntry + SL_DISTANCE;
                }
              }

              console.log(
                `[ENTRY REFRESH] ${pairId} entry updated: ${oldEntry} → ${newEntry}, internalSL=${rec.internalSL}`
              );
            }
          }
        }
      } catch (err) {
        console.log(`[ENTRY REFRESH ERROR] ${pairId}`, err.message);
      }

      // 4️⃣ Fetch latest price
      const price = await safeGetPrice(SYMBOL);
      if (!price || price.bid == null || price.ask == null) continue;

      const current = side === 'BUY' ? price.bid : price.ask;


      //----------------------------------------------------------
      // TIGHT SL OVERRIDE WHEN OPPOSITE MATURED TRADE EXISTS
      //----------------------------------------------------------
      try {
          // Check if there exists ANY opposite matured trade
          const oppositeMaturedExists = Object.values(openPairs).some(other => {
              return other.pairId !== rec.pairId &&
                    other.side !== rec.side &&
                    other.partialClosed === true &&
                    other.trades?.TRAILING?.ticket;
          });

          if (oppositeMaturedExists && !rec.partialClosed && !rec.breakEvenActive) {

              rec.tightSLMode = true;   // <-- NEW FLAG
              // Apply tight override SL only before BE activates
              const TIGHT_SL = 5;

              const desiredSL = rec.side === "BUY"
                  ? rec.entryPrice - TIGHT_SL
                  : rec.entryPrice + TIGHT_SL;

              // Only tighten if it's STRICTLY tighter than current SL
              if (!rec.internalSL || 
                  (rec.side === "BUY"  && desiredSL > rec.internalSL) ||
                  (rec.side === "SELL" && desiredSL < rec.internalSL)) {

                  rec.internalSL = desiredSL;

                  console.log(`[MONITOR] Tight SL override applied to ${pairId}: ${desiredSL}`);
                  const safePairId = md2(pairId);
                  await sendTelegram(
                      `⚠️ *TIGHT SL APPLIED*\nPair: ${safePairId}\nReason: Opposite matured trade exists\nSL: ${desiredSL}`,
                      { parse_mode: 'MarkdownV2' }
                  );
              }
          }
      } catch (err) {
          console.log(`[MONITOR] Tight SL override error for ${pairId}:`, err.message);
      }


      // --- NOTE ---
      // This monitor layer remains intentionally light.
      // All the heavy lifting (partial/BE/trailing/SL hit)
      // is already handled inside processTickForOpenPairs().
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
    console.log("\n\n======================");
    console.log("[WEBHOOK] Incoming Payload:", JSON.stringify(payload, null, 2));
    console.log("======================\n");

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
    console.log("[WEBHOOK] Parsed Signal:", parsed);

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

              console.log(`[ZONE] Updated ${category} ${timeframe} → ${approval}`);

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


      // --------------------------------------
      // RAPID-FIRE ENTRY LOCK (2 seconds)
      // --------------------------------------
      if (entryProcessingLock) {
        console.log("[ENTRY] ⛔ Blocked: Rapid-fire entry detected");
        return res.status(429).json({
          ok: false,
          error: "Another entry is being processed. Try again."
        });
      }

      // Activate lock
      entryProcessingLock = true;

      // Auto-clear after 2 seconds
      setTimeout(() => {
        entryProcessingLock = false;
      }, 2000);


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
        return res.status(403).json({
            ok: false,
            error: `Approval zones not satisfied: 3M=${zone3}, 5M=${zone5}`
        });
      }


      if (!category) {
        console.log("[ENTRY] ❌ Invalid category");
        return res.status(400).json({ ok: false, error: "Invalid category" });
      }

      // ---- CATEGORY LIMIT CHECK ----
      console.log(`[ENTRY] Category Count(${category}) = ${countCategory(category)}, Max=${MAX_PER_CATEGORY}`);

      if (countCategory(category) >= MAX_PER_CATEGORY) {
        console.log(`[ENTRY] ❌ Blocked: Category limit reached for ${category}`);
        return res.status(429).json({ ok: false, error: `Max trades reached for ${category}` });
      }

      // ---- SAME-SIDE COOLDOWN CHECK ----
      const elapsed = now - lastEntryTime[side];
      console.log(`[ENTRY] Cooldown check: side=${side}, elapsed=${elapsed}ms, cooldown=${SIDE_COOLDOWN_MS}ms`);

      if (elapsed < SIDE_COOLDOWN_MS) {
        const remaining = SIDE_COOLDOWN_MS - elapsed;
        const mins = Math.ceil(remaining / 60000);
        console.log(`[ENTRY] ⛔ Same-side cooldown active → ${mins}m remaining`);
        return res.status(429).json({
          ok: false,
          error: `Cooldown active for ${side}. Try again in ${mins} min`
        });
      }

      // Mark idempotency ID early
      if (signalId) processedSignalIds.add(signalId);

      // ---- LOT SIZING ----
      console.log("[ENTRY] Calculating lot size...");
      const totalLot = await internalLotSizing();
      console.log("[ENTRY] Lot decided:", totalLot);

      // ---- PLACE PAIRED ORDER ----
      console.log("[ENTRY] Placing paired order...");
      const prePair = await placePairedOrder(side, totalLot, null, null);

      if (!prePair) {
        console.log("[ENTRY] ❌ Order failed → removing signalId & exiting");
        if (signalId) processedSignalIds.delete(signalId);
        return res.status(500).json({ ok: false, error: "Entry failed" });
      }

      console.log("[ENTRY] ✔ Paired order placed:", prePair);

      // ---- SL CALCULATION ----
      const { sl } = await internalSLTPLogic(side, prePair.entryPrice);
      console.log(`[ENTRY] SL calculated: ${sl}`);

      openPairs[prePair.pairId].sl = sl;
      openPairs[prePair.pairId].tp = null;
      openPairs[prePair.pairId].category = category;
      openPairs[prePair.pairId].signalId = signalId || null;

      // ---- START COOLDOWN NOW ----
      lastEntryTime[side] = Date.now();
      console.log(`[ENTRY] Cooldown started for side=${side}`);
      const safeCategory = category.replace(/[^a-zA-Z0-9 ]/g, '');
      const safePairId = md2(prePair.pairId);


      // ---- TELEGRAM ----
      await sendTelegram(
        `🟢 *ENTRY* ${safeCategory}\n` +
        `🎫 ${safePairId}\n` +
        `📈 ${side}\n` +
        `💵 Entry: ${md2(prePair.entryPrice.toFixed(2))}\n` +
        `SL: ${md2(sl.toFixed(2))}\n` +
        `🕒 ${new Date().toLocaleTimeString()}`,
        { parse_mode: "MarkdownV2" }
      );




      console.log("[ENTRY] ✔ ENTRY completed\n");

      return res.status(200).json({ ok: true, pair: openPairs[prePair.pairId] });
    }

    // ================================
    //           CLOSE LOGIC
    // ================================
    if (parsed.kind === "CLOSE") {
      const side = parsed.side;
      console.log(`[CLOSE] Received CLOSE signal for side=${side}`);

      const toClose = Object.entries(openPairs).filter(([_, rec]) => rec.side === side);

      console.log(`[CLOSE] Found ${toClose.length} pairs to close`);

      if (signalId) processedSignalIds.add(signalId);

      for (const [pairId, rec] of toClose) {
        console.log(`[CLOSE] Closing pairId=${pairId}`);

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

        rec.awaitingFinalClose = true;

        const safePairId = md2(pairId);

        await sendTelegram(
          `🔴 *CLOSE SIGNAL*\nClosed: ${safePairId} (${side})`,
          { parse_mode: "MarkdownV2" }
        );



        console.log(`[CLOSE] ✔ Pair closed: ${pairId}`);
      }

      return res.status(200).json({ ok: true, closed: toClose.length });
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
