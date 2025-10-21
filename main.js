// bot_merged.js
// Merged: main strategy bot + robust order execution helpers from test_order_execution.js
// - Base strategy and candle aggregation from your main bot
// - Robust order/position helpers, tolerant close behavior, and safe getters from your debug test
// NOTE: Test on demo before running live

require('dotenv').config()
const fs = require('fs');
const path = require('path');
const MetaApi = require('metaapi.cloud-sdk').default;
const MetaStats = require('metaapi.cloud-metastats-sdk').default;
const ti = require('technicalindicators');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { setTimeout: delay } = require('timers/promises');

// --------------------- CONFIG ---------------------
const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
const SYMBOL = process.env.SYMBOL || "XAUUSDm"; // change to XAUUSDm/GOLD/etc. per broker
const TICK_CACHE_FILE = path.join(__dirname, `data/tick_cache_${SYMBOL}.json`);

const MAX_OPEN_TRADES = 3;
const MAX_TOTAL_RISK = 0.06; // 6%
const DEFAULT_RISK_PER_NEW_TRADE = 0.02; // 2%
const COOLDOWN_MINUTES = 10;
const MIN_LOT = 0.01;
const LOT_ROUND = 2;
const ATR_PERIOD = 14;
const ATR_SL_MULTIPLIER = 1.2;
const STRONG_TREND_BBW = 0.02;
const CHECK_INTERVAL_MS = 10_000;

// --------------------- TELEGRAM SETUP ---------------------
const TelegramBot = require('node-telegram-bot-api');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let tgBot = null;
let lastZoneSignal = null; // { type: 'BUY'|'SELL', candleTime: 'ISO' }


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
let api, account, connection, metastatsApi;
let accountBalance = 0;
let candlesM1 = []
let candlesM5 = []
let candlesM30 = []
let lastSignal = null;
let lastKnownTrend = null;
const botStartTime = Date.now();
let usingM5Fallback = false;
let warmUpComplete = false;
let lastTickPrice = null;
let stagnantTickCount = 0;
let stagnantSince = null;
let marketFrozen = false;
let openPairs = {}; // ticket -> metadata

// --------------------- HELPERS: Indicators & Trend ---------------------
function calculateIndicators(values, highs, lows) {
  const rsi = values.length >= 14 ? ti.RSI.calculate({ period: 14, values }) : [];
  const stochastic = (values.length >= 14 && highs.length >= 14 && lows.length >= 14)
    ? ti.Stochastic.calculate({ period: 14, signalPeriod: 3, high: highs, low: lows, close: values })
    : [];
  const bb = values.length >= 20 ? ti.BollingerBands.calculate({ period: 20, values, stdDev: 2 }) : [];
  const atr = (values.length >= ATR_PERIOD && highs.length >= ATR_PERIOD && lows.length >= ATR_PERIOD)
    ? ti.ATR.calculate({ period: ATR_PERIOD, high: highs, low: lows, close: values })
    : [];
  return { rsi, stochastic, bb, atr };
}

function determineMarketTypeFromBB(values, bbArray, lookback = 20) {
  if (!bbArray.length || !values.length) return 'sideways';

  const n = Math.min(lookback, values.length, bbArray.length);
  let above = 0, below = 0;

  for (let i = 0; i < n; i++) {
    const vi = values[values.length - 1 - i];
    const bbi = bbArray[bbArray.length - 1 - i];
    if (!bbi) continue;
    if (vi > bbi.middle) above++;
    if (vi < bbi.middle) below++;
  }

  const pctAbove = above / n;
  const bbw = (bbArray.at(-1).upper - bbArray.at(-1).lower) / bbArray.at(-1).middle;

  // Tuned thresholds (works well for both Gold and BTC)
  const STRONG_TREND_BBW = 0.018;
  const SIDEWAYS_BBW = 0.012;
  const UPPER_PCT = 0.58;
  const LOWER_PCT = 0.42;

  if (bbw > STRONG_TREND_BBW && pctAbove > UPPER_PCT) return 'uptrend';
  if (bbw > STRONG_TREND_BBW && pctAbove < LOWER_PCT) return 'downtrend';

  if (bbw > SIDEWAYS_BBW) {
    if (pctAbove > 0.62) return 'uptrend';
    if (pctAbove < 0.38) return 'downtrend';
  }

  return 'sideways';
}




// --------------------- HELPERS: Money & Lot sizing ---------------------
function roundLot(lot) {
  return Math.max(MIN_LOT, parseFloat(lot.toFixed(LOT_ROUND)));
}

function computeAllowedRiskForNewTrade(currentOpenCount) {
  const used = Object.values(openPairs).reduce((s, r) => s + (r.riskPercent || 0), 0);
  const remaining = Math.max(0, MAX_TOTAL_RISK - used);
  const remainingSlots = Math.max(1, MAX_OPEN_TRADES - currentOpenCount);
  // split remaining among remaining slots but cap by DEFAULT
  return Math.min(DEFAULT_RISK_PER_NEW_TRADE, remaining / remainingSlots);
}

// Corrected 2% risk-based lot sizing
function calculateLotFromRisk(balance, riskPercent, slPriceDiff, contractSize = 100) {
  // slPriceDiff: absolute price difference between entry and SL (in price units)
  const riskAmount = balance * riskPercent;
  if (!slPriceDiff || slPriceDiff <= 0) return MIN_LOT;
  const lot = riskAmount / (slPriceDiff * contractSize);
  return roundLot(lot);
}


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


// safeGetAccountBalance - tolerant retrieval
async function safeGetAccountBalance() {
  try {
    if (connection?.terminalState?.accountInformation?.balance != null)
      return connection.terminalState.accountInformation.balance;
  } catch (e) {}

  try {
    if (account?._data?.balance != null) return account._data.balance;
  } catch (e) {}

  try {
    if (metastatsApi?.getMetrics) {
      const metrics = await metastatsApi.getMetrics(ACCOUNT_ID);
      if (metrics?.balance || metrics?.equity)
        return metrics.balance || metrics.equity;
    }
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

// safePlacePairedMarketOrder - robust attempts to call several API variants
async function placePairedOrder(side, totalLot, slPrice, tpPrice, riskPercent) {
  const lotEach = roundLot(totalLot / 2);
  if (lotEach < MIN_LOT) {
    console.log('[PAIR] Computed lot too small, aborting pair order');
    return null;
  }

  const first = await safePlaceMarketOrder(side, lotEach, slPrice, tpPrice);
  await new Promise(r => setTimeout(r, 400)); // small delay
  const second = await safePlaceMarketOrder(side, lotEach, slPrice, tpPrice);

  const pairId = `pair-${Date.now()}`;
  openPairs[pairId] = {
    pairId,
    side,
    riskPercent,
    totalLot: lotEach * 2,
    trades: {
      PARTIAL: { ticket: first?.positionId || first?.orderId || null, lot: lotEach },
      TRAILING: { ticket: second?.positionId || second?.orderId || null, lot: lotEach }
    },
    sl: slPrice,
    tp: tpPrice,
    internalTrailingSL: null,
    partialClosed: false,
    openedAt: new Date().toISOString()
  };
  console.log('[PAIR OPENED]', pairId, openPairs[pairId]);
  return openPairs[pairId];
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

// --------------------- CANDLE HANDLER ---------------------

let lastStrategyRun = 0;
const STRATEGY_COOLDOWN_MS = 60_000; // 1 minute

function onCandle(candle) {
  if (!candle) return;

  const { timeframe, high, low, close, timestamp } = candle;


  // Only trigger strategy on a new 5-minute candle
  if (timeframe === '5m') {
    checkStrategy(new Date(timestamp * 1000).toISOString())
      .catch(err => console.error('checkStrategy error:', err));
  }

}

function updateCandle(tf, tickPrice, tickTime) {
  const tfSeconds = tf === '1m' ? 60 : tf === '5m' ? 300 : 1800;
  const ts = Math.floor(tickTime / tfSeconds) * tfSeconds;
  const arr = tf === '1m' ? candlesM1 : tf === '5m' ? candlesM5 : candlesM30;
  const last = arr[arr.length - 1];

  if (last && last.timestamp === ts) {
    // Update the existing candle
    last.high = Math.max(last.high, tickPrice);
    last.low = Math.min(last.low, tickPrice);
    last.close = tickPrice;
  } else {
    // Close previous candle
    if (last) {
      onCandle({
        timeframe: tf,
        ...last,
        time: new Date(last.timestamp * 1000).toISOString()
      });
    }

    // Start a new candle
    arr.push({
      timestamp: ts,
      open: tickPrice,
      high: tickPrice,
      low: tickPrice,
      close: tickPrice
    });

    if (arr.length > 500) arr.shift();
  }
}

// --------------------- TICK HANDLER WITH MARKET FREEZE DETECTION ---------------------
async function handleTick(tick) {
  try {
    const tickPrice = tick.bid ?? tick.ask ?? tick.price;
    const tickTime = Math.floor(Date.now() / 1000);

    // --- Detect stagnant price movement ---
    if (lastTickPrice !== null) {
      if (tickPrice !== lastTickPrice) {
        // ✅ Price moved → reset freeze counters
        if (marketFrozen) {
          marketFrozen = false;
          stagnantTickCount = 0;
          console.log(`[MARKET] ✅ Price movement resumed. Resuming candle updates.`);
          await sendTelegram(
            `✅ *MARKET ACTIVE AGAIN*\n━━━━━━━━━━━━━━━\n💹 Price movement detected\n🕒 ${new Date().toLocaleTimeString()}\n📈 Candle updates resumed.`,
            { parse_mode: 'Markdown' }
          );
        } else {
          stagnantTickCount = 0;
        }
      } else {
        // ❌ Price unchanged → count as stagnant
        stagnantTickCount++;

        // After ~2 minutes (60 ticks @ 2s interval), mark market as frozen
        if (stagnantTickCount > 60 && !marketFrozen) {
          marketFrozen = true;
          stagnantSince = new Date().toISOString();

          console.warn(`[MARKET] ⚠️ Market appears frozen since ${stagnantSince}. Pausing candle aggregation.`);
          await sendTelegram(
            `⚠️ *MARKET FROZEN DETECTED*\n━━━━━━━━━━━━━━━\n📉 *No price movement detected*\n🕒 Since: ${new Date().toLocaleTimeString()}\n⏸️ Candle updates paused until movement resumes.`,
            { parse_mode: 'Markdown' }
          );
        }

        // Skip candle updates while market is frozen
        if (marketFrozen) return;
      }
    }

    lastTickPrice = tickPrice;

    // --- Update candle arrays only when market is active ---
    if (!marketFrozen) {
      updateCandle('1m', tickPrice, tickTime);
      updateCandle('5m', tickPrice, tickTime);
      updateCandle('30m', tickPrice, tickTime);
    }

  } catch (e) {
    console.warn('[TICK] Candle update error:', e.message);
  }
}



// --------------------- CORE: Strategy & Execution ---------------------
async function checkStrategy(m5CandleTime = null) {

  // ⏱️ Warm-up control
  const runtimeMinutes = (Date.now() - botStartTime) / 60000;
  const m30Ready = candlesM30.length >= 22;

  if (marketFrozen) {
    console.log('[STRAT] ⏸️ Market frozen — skipping strategy evaluation.');
    return;
  }

  // 🚫 Do not run any strategy or indicators for the first 2 hours
  if (runtimeMinutes < 120) {
    return; // Exit early: only collecting candle data
  }

  // 🔔 One-time warm-up completion notification
  if (!warmUpComplete) {
    warmUpComplete = true;
    console.log(`[TREND] ✅ Warm-up complete — strategy is now ACTIVE.`);
    await sendTelegram(
      `✅ *STRATEGY ACTIVE*\n━━━━━━━━━━━━━━━\n🕒 Runtime: ${runtimeMinutes.toFixed(1)} min\n📈 Candles: M1=${candlesM1.length}, M5=${candlesM5.length}, M30=${candlesM30.length}\n🚀 The bot has completed its 2-hour warm-up and is now LIVE.`,
      { parse_mode: 'Markdown' }
    );
  }

  // ✅ After 2 hours, begin normal indicator calculations
  const closesM1 = candlesM1.map(c => c.close);
  const highsM1 = candlesM1.map(c => c.high);
  const lowsM1  = candlesM1.map(c => c.low);
  const ind1 = calculateIndicators(closesM1, highsM1, lowsM1);

  const closesM5 = candlesM5.map(c => c.close);
  const highsM5 = candlesM5.map(c => c.high);
  const lowsM5  = candlesM5.map(c => c.low);
  const ind5 = calculateIndicators(closesM5, highsM5, lowsM5);

  const closesM30 = candlesM30.map(c => c.close);
  const highsM30 = candlesM30.map(c => c.high);
  const lowsM30  = candlesM30.map(c => c.low);
  const ind30 = calculateIndicators(closesM30, highsM30, lowsM30);

  // 🧠 Determine higher timeframe trend
  let higherTrend;

  if (m30Ready) {
    // ✅ Normal: use M30 (20-candle lookback)
    higherTrend = determineMarketTypeFromBB(closesM30, ind30.bb || [], 20);
    if (usingM5Fallback) {
      console.log(`[TREND] ✅ Switched back to M30 trend — M30 data now sufficient (${candlesM30.length} candles).`);
      usingM5Fallback = false;
    }
  } else {
    // ⚠️ After 2h but M30 still not ready → use M5 fallback
    higherTrend = determineMarketTypeFromBB(closesM5, ind5.bb || [], 24);
    if (!usingM5Fallback) {
      console.log(`[TREND] ⚠️ Using M5 fallback — runtime ${runtimeMinutes.toFixed(1)} min > 120, only ${candlesM30.length} M30 candles.`);
      usingM5Fallback = true;
    }
  }

  // 🧭 Preserve trend memory and effective bias
  if (higherTrend !== 'sideways') {
    lastKnownTrend = higherTrend;
  }

  let effectiveTrend = higherTrend;
  if (higherTrend === 'sideways' && lastKnownTrend) {
    effectiveTrend = lastKnownTrend;
  }

  console.log(`[TREND] Final effective trend: ${effectiveTrend.toUpperCase()} (higherTF=${higherTrend}, lastKnown=${lastKnownTrend || 'none'})`);

  // --- Safety: skip if indicators incomplete ---
  const lastRSI_M5 = ind5.rsi.at(-1);
  const lastStoch_M5 = ind5.stochastic.at(-1);
  const prevStoch_M5 = ind5.stochastic.at(-2);
  const lastRSI_M1 = ind1.rsi.at(-1);
  const lastStoch_M1 = ind1.stochastic.at(-1);
  const lastATR_M5 = ind5.atr.at(-1) || 0;

  if (!lastStoch_M5 || !prevStoch_M5 || !lastStoch_M1) return; // safety check

  console.log(`[STRAT] M30:${higherTrend} | M5 RSI:${lastRSI_M5?.toFixed(2)} Stoch:${lastStoch_M5?.k?.toFixed(2)} | M1 RSI:${lastRSI_M1?.toFixed(2)} Stoch:${lastStoch_M1?.k?.toFixed(2)}`);

  // --- Positions ---
  const openPositions = await safeGetPositions();
  await syncOpenPairsWithPositions(openPositions);

  // --- Risk check ---
  if (openPositions.length >= MAX_OPEN_TRADES) {
    await monitorOpenTrades(ind30, ind5, ind1);
    return;
  }

  const allowedRiskPercent = computeAllowedRiskForNewTrade(openPositions.length);
  if (allowedRiskPercent <= 0) {
    console.log('No remaining risk budget for new trades.');
    await monitorOpenTrades(ind30, ind5, ind1);
    return;
  }

  // --- Entry Triggers ---
  const buyM5Trigger = (prevStoch_M5.k < 25 && lastStoch_M5.k >= 25 && lastRSI_M5 < 50);
  const buyM1Confirm = (lastRSI_M1 < 55);
  const sellM5Trigger = (prevStoch_M5.k > 75 && lastStoch_M5.k <= 75 && lastRSI_M5 > 50);
  const sellM1Confirm = (lastRSI_M1 > 45);

  // --- Potential Zone Alerts ---
  if (
    effectiveTrend === 'uptrend' &&
    buyM5Trigger &&
    !buyM1Confirm &&
    (!lastZoneSignal || lastZoneSignal.type !== 'BUY' || lastZoneSignal.candleTime !== m5CandleTime)
  ) {
    await sendTelegram(
      `⚡ *POTENTIAL BUY ZONE DETECTED*\n━━━━━━━━━━━━━━━\n📊 *Trend:* ${effectiveTrend.toUpperCase()}\n📍 *Trigger:* M5 bullish setup detected\n💡 Waiting for M1 confirmation...\n⏰ ${new Date().toLocaleTimeString()}`,
      { parse_mode: 'Markdown' }
    );
    lastZoneSignal = { type: 'BUY', candleTime: m5CandleTime };
  }

  if (
    effectiveTrend === 'downtrend' &&
    sellM5Trigger &&
    !sellM1Confirm &&
    (!lastZoneSignal || lastZoneSignal.type !== 'SELL' || lastZoneSignal.candleTime !== m5CandleTime)
  ) {
    await sendTelegram(
      `⚡ *POTENTIAL SELL ZONE DETECTED*\n━━━━━━━━━━━━━━━\n📊 *Trend:* ${effectiveTrend.toUpperCase()}\n📍 *Trigger:* M5 bearish setup detected\n💡 Waiting for M1 confirmation...\n⏰ ${new Date().toLocaleTimeString()}`,
      { parse_mode: 'Markdown' }
    );
    lastZoneSignal = { type: 'SELL', candleTime: m5CandleTime };
  }

  // --- SL & TP Calculation ---
  const slDistance = lastATR_M5 * ATR_SL_MULTIPLIER;
  const minSlDistance = 20 * 0.1;
  const effectiveSl = Math.max(slDistance || 0, minSlDistance);

  if (!accountBalance || accountBalance === 0) {
    accountBalance = await safeGetAccountBalance();
  }

  const slPriceDiff = effectiveSl;
  const CONTRACT_SIZE = 100;
  const lot = calculateLotFromRisk(accountBalance, allowedRiskPercent, slPriceDiff, CONTRACT_SIZE);

  const trr = (() => {
    try {
      const bbw30 = (ind30.bb.at(-1).upper - ind30.bb.at(-1).lower) / ind30.bb.at(-1).middle;
      const m30Type = determineMarketTypeFromBB(closesM30, ind30.bb);
      if (m30Type === 'uptrend' || m30Type === 'downtrend') {
        if (bbw30 > STRONG_TREND_BBW) return 3.0;
        return 2.0;
      }
    } catch (e) {}
    return 1.5;
  })();

  // --- Execute Trade ---
  const price = await safeGetPrice(SYMBOL);
  if (!price) {
    console.warn('[STRAT] Price unavailable, skipping trade attempt.');
    await monitorOpenTrades(ind30, ind5, ind1);
    return;
  }

  const ask = price.ask, bid = price.bid;

  // BUY
  if ((effectiveTrend === 'uptrend') && buyM5Trigger && buyM1Confirm) {
    const candleTime = m5CandleTime || new Date().toISOString();
    if (!canTakeTrade('BUY', candleTime)) {
      console.log('BUY blocked by cooldown/duplicate guard.');
    } else {
      const slPrice = ask - effectiveSl;
      const tpPrice = ask + effectiveSl * trr;
      if ((openPositions.length < MAX_OPEN_TRADES) && allowedRiskPercent > 0) {
        try {
          const pair = await placePairedOrder('BUY', lot, slPrice, tpPrice, allowedRiskPercent);
          if (pair) {
            console.log('BUY pair placed:', pair);
            lastSignal = { type: 'BUY', m5CandleTime: candleTime, time: new Date().toISOString() };
          }
        } catch (e) {
          console.error('BUY place order failed:', e.message || e);
        }
      }
    }
  }

  // SELL
  if ((effectiveTrend === 'downtrend') && sellM5Trigger && sellM1Confirm) {
    const candleTime = m5CandleTime || new Date().toISOString();
    if (!canTakeTrade('SELL', candleTime)) {
      console.log('SELL blocked by cooldown/duplicate guard.');
    } else {
      const slPrice = bid + effectiveSl;
      const tpPrice = bid - effectiveSl * trr;
      if ((openPositions.length < MAX_OPEN_TRADES) && allowedRiskPercent > 0) {
        try {
          const pair = await placePairedOrder('SELL', lot, slPrice, tpPrice, allowedRiskPercent);
          if (pair) {
            console.log('SELL pair placed:', pair);
            lastSignal = { type: 'SELL', m5CandleTime: candleTime, time: new Date().toISOString() };
          }
        } catch (e) {
          console.error('SELL place order failed:', e.message || e);
        }
      }
    }
  }

  // --- Always monitor open trades for trailing/partial logic ---
  await monitorOpenTrades(ind30, ind5, ind1);
}

// --------------------- GUARDS & RECORDING ---------------------

function canTakeTrade(type, m5CandleTime) {
  if (!lastSignal) return true;
  if (lastSignal.type !== type) return true;
  if (!m5CandleTime) return true;
  if (lastSignal.m5CandleTime === m5CandleTime) return false;
  const lastTime = new Date(lastSignal.time);
  const now = new Date();
  const diffMin = (now - lastTime) / 60000;
  if (diffMin < COOLDOWN_MINUTES && lastSignal.type === type) return false;
  return true;
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

      // if PARTIAL ticket missing on broker
      if (pTicket && !openTickets.has(pTicket)) {
        console.log(`[SYNC] PARTIAL trade ${pTicket} missing on broker — marking closed`);
        rec.trades.PARTIAL.ticket = null;
        rec.partialClosed = true;
      }

      // if TRAILING ticket missing on broker
      if (tTicket && !openTickets.has(tTicket)) {
        console.log(`[SYNC] TRAILING trade ${tTicket} missing on broker — marking closed`);
        rec.trades.TRAILING.ticket = null;
      }

      // if both tickets gone → remove record
      if (!rec.trades.PARTIAL.ticket && !rec.trades.TRAILING.ticket) {
        console.log(`[SYNC] Both trades of pair ${pairId} closed — removing pair`);
        delete openPairs[pairId];
      }
    }

    // Step 2️⃣ — detect any new broker positions we’re not tracking
    for (const pos of positions) {
      const ticket = pos.positionId || pos.ticket || pos.id;
      if (!ticket) continue;

      // if already in openPairs somewhere, skip
      const isTracked = Object.values(openPairs).some(
        rec =>
          rec.trades.PARTIAL?.ticket === ticket ||
          rec.trades.TRAILING?.ticket === ticket
      );
      if (isTracked) continue;

      // create singleton fallback record (in case of manual trades)
      const singletonId = `ext-${ticket}`;
      openPairs[singletonId] = {
        pairId: singletonId,
        side: pos.side || (pos.type === 'buy' ? 'BUY' : 'SELL'),
        totalLot: pos.volume || pos.lots || pos.size || 0,
        riskPercent: 0,
        trades: {
          PARTIAL: { ticket, lot: pos.volume || pos.lots || pos.size || 0 },
          TRAILING: { ticket: null, lot: 0 }
        },
        entryPrice: pos.openPrice || pos.averagePrice || pos.price,
        sl: pos.stopLoss || null,
        tp: pos.takeProfit || null,
        internalTrailingSL: null,
        partialClosed: false,
        external: true,
        openedAt: pos.openTime || new Date().toISOString()
      };

      console.log(`[SYNC] Registered external singleton position: ${ticket}`);
    }
  } catch (e) {
    console.error('[SYNC] Error syncing positions:', e.message || e);
  }
}


// --------------------- MONITOR: internal trailing + partial close + close on trend weaken ---------------------
async function monitorOpenTrades(ind30, ind5, ind1) {
  try {
    const positions = await safeGetPositions();
    await syncOpenPairsWithPositions(positions);

    const closesM30 = candlesM30.map(c => c.close);
    const higherTrend = determineMarketTypeFromBB(closesM30, ind30.bb || []);
    const trendStrong = higherTrend !== 'sideways';

    // Iterate over all open trade records
    for (const [pairId, rec] of Object.entries(openPairs)) {
      const side = rec.side;
      const partial = rec.trades?.PARTIAL;
      const trailing = rec.trades?.TRAILING;

      const price = await safeGetPrice(SYMBOL);
      if (!price) continue;

      const current = side === 'BUY' ? price.bid : price.ask;

      // --- PARTIAL CLOSE LOGIC (at 50% TP)
      if (
        !rec.partialClosed &&
        rec.tp &&
        rec.entryPrice &&
        partial?.ticket
      ) {
        const totalDist = Math.abs(rec.tp - rec.entryPrice);
        const currentDist = Math.abs(rec.tp - current);
        const progress = 1 - currentDist / totalDist;

        if (progress >= 0.5) {
          console.log(`[PAIR] Partial close condition met for ${pairId}`);
          try {
            await safeClosePosition(partial.ticket, partial.lot);
            rec.partialClosed = true;
            rec.trades.PARTIAL.ticket = null;
            await sendTelegram(
              `🟠 *PARTIAL CLOSED*\n━━━━━━━━━━━━━━━\n🎫 *Pair:* ${pairId}\n📈 *Side:* ${side}\n💰 *Lot Closed:* ${partial.lot}\n🕒 ${new Date().toLocaleTimeString()}`,
              { parse_mode: "Markdown" }
            );

            // ✅ Refresh balance after partial close
            try {
              const newBalance = await safeGetAccountBalance();
              if (newBalance && newBalance !== accountBalance) {
                accountBalance = newBalance;
              }
            } catch (err) {
              console.warn('[BALANCE] Post-close update failed:', err.message);
            }
          } catch (e) {
            console.warn(`[PAIR] Partial close failed for ${pairId}:`, e.message);
          }
        }
      }

      // --- INTERNAL TRAILING STOP UPDATE
      const atr = ind5.atr.at(-1) || 0;
      if (atr > 0) {
        const newSL =
          side === "BUY" ? current - atr * 1.0 : current + atr * 1.0;

        if (
          !rec.internalTrailingSL ||
          (side === "BUY"
            ? newSL > rec.internalTrailingSL + 0.5
            : newSL < rec.internalTrailingSL - 0.5)
        ) {
          rec.internalTrailingSL = newSL;
        }
      }

      // --- INTERNAL TRAILING STOP BREACH
      if (rec.internalTrailingSL && trailing?.ticket) {
        const hit =
          side === "BUY"
            ? current <= rec.internalTrailingSL
            : current >= rec.internalTrailingSL;

        if (hit) {
          console.log(`[PAIR] Internal SL hit for ${pairId} -> closing trailing trade`);
          try {
            await safeClosePosition(trailing.ticket, trailing.lot);
            rec.trades.TRAILING.ticket = null;

            await sendTelegram(
              `🔴 *TRAILING STOP HIT*\n━━━━━━━━━━━━━━━\n🎫 *Pair:* ${pairId}\n📈 *Side:* ${side}\n💰 *Lot Closed:* ${trailing.lot}\n🕒 ${new Date().toLocaleTimeString()}`,
              { parse_mode: "Markdown" }
            );

            // ✅ Refresh balance after partial close
            try {
              const newBalance = await safeGetAccountBalance();
              if (newBalance && newBalance !== accountBalance) {
                accountBalance = newBalance;
              }
            } catch (err) {
              console.warn('[BALANCE] Post-close update failed:', err.message);
            }

            // Remove record if both sides are now closed
            if (!rec.trades.PARTIAL.ticket && !rec.trades.TRAILING.ticket)
              delete openPairs[pairId];

          } catch (e) {
            console.warn(`[PAIR] Failed to close trailing trade for ${pairId}:`, e.message);
          }
        }
      }

      // --- CLOSE ON TREND WEAKEN
      if (!trendStrong) {
        console.log(`[PAIR] Trend weakened -> closing all for ${pairId}`);
        for (const key of ["PARTIAL", "TRAILING"]) {
          const trade = rec.trades[key];
          if (trade?.ticket) {
            await safeClosePosition(trade.ticket, trade.lot);
            trade.ticket = null;
          }
        }
        delete openPairs[pairId];

        await sendTelegram(
          `🔻 *PAIR CLOSED (TREND WEAKENED)*\n━━━━━━━━━━━━━━━\n🎫 *Pair:* ${pairId}\n📈 *Side:* ${side}\n🕒 ${new Date().toLocaleTimeString()}`,
          { parse_mode: "Markdown" }
        );
        
        // ✅ Refresh balance after partial close
        try {
          const newBalance = await safeGetAccountBalance();
          if (newBalance && newBalance !== accountBalance) {
            accountBalance = newBalance;
          }
        } catch (err) {
          console.warn('[BALANCE] Post-close update failed:', err.message);
        }

      }
    }
  } catch (e) {
    console.error("monitorOpenTrades error:", e.message || e);
  }
}




// --------------------- MAIN LOOP ---------------------

async function startBot() {
  const MetaApi = require('metaapi.cloud-sdk').default;
  const MetaStats = require('metaapi.cloud-metastats-sdk').default;
  const { setTimeout: delay } = require('timers/promises');

  const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
  const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID;
  const SYMBOL = process.env.SYMBOL || "XAUUSDm";

  // Retry and alert settings
  let retryDelay = 2 * 60 * 1000; // 2 minutes
  const MAX_DELAY = 20 * 60 * 1000; // cap 20 min
  const MAINTENANCE_ALERT_THRESHOLD = 30 * 60 * 1000; // 30 minutes

  // Local state
  let api, metastatsApi, account, connection;
  let accountBalance = 0;
  let reconnecting = false;
  let lastTickTime = Date.now();
  let lastDisconnectTime = null;
  let maintenanceAlertSent = false;

  console.log(`[BOT] Starting MetaApi bot for ${SYMBOL}`);

  try {
    // 1️⃣ Initialize MetaApi & get account
    api = new MetaApi(METAAPI_TOKEN);
    metastatsApi = new MetaStats(METAAPI_TOKEN);
    account = await api.metatraderAccountApi.getAccount(ACCOUNT_ID);

    // 2️⃣ Ensure account is deployed and connected
    if (account.state !== 'DEPLOYED') {
      console.log('[METAAPI] Account not deployed — deploying...');
      await account.deploy();
      await account.waitConnected();
    }
    if (account.connectionStatus !== 'CONNECTED') {
      console.log('[METAAPI] Waiting for broker connection...');
      await account.waitConnected();
    }

    // 3️⃣ Create and synchronize streaming connection
    connection = account.getStreamingConnection();
    console.log('[METAAPI] Connecting streaming connection...');
    await connection.connect();
    await connection.waitSynchronized();
    console.log('[METAAPI] ✅ Streaming connection synchronized.');

    // 4️⃣ Subscribe to symbol after sync
    if (typeof connection.subscribeToMarketData === 'function') {
      await connection.subscribeToMarketData(SYMBOL);
      console.log(`[METAAPI] Subscribed to market data for ${SYMBOL}`);
    }

    // 5️⃣ Verify first price tick before proceeding
    console.log('[METAAPI] Waiting for first valid price tick...');
    while (true) {
      const p = connection?.terminalState?.price(SYMBOL);
      if (p && p.bid != null && p.ask != null) break;
      await delay(500);
    }
    console.log('[METAAPI] ✅ First price tick received.');

    // 6️⃣ Fetch account balance safely
    const info = connection?.terminalState?.accountInformation || {};
    accountBalance = info.balance || 0;
    console.log(`✅ Connected to MetaApi. Balance: ${accountBalance.toFixed(2)}`);

    await sendTelegram(
      `✅ *BOT CONNECTED TO METAAPI*\n━━━━━━━━━━━━━━━\n📊 Symbol: ${SYMBOL}\n💰 Balance: ${accountBalance.toFixed(2)}\n🕒 ${new Date().toLocaleTimeString()}`,
      { parse_mode: 'Markdown' }
    );

    // 7️⃣ Reset reconnect timers
    retryDelay = 2 * 60 * 1000;
    lastDisconnectTime = null;
    maintenanceAlertSent = false;

    console.log('🤖 Bot ready and running. Listening to live tick stream for', SYMBOL);

    // 8️⃣ Tick polling loop
    const pollIntervalMs = 2000;
    setInterval(async () => {
      try {
        const price = connection?.terminalState?.price(SYMBOL);
        if (price && price.bid != null && price.ask != null) {
          lastTickTime = Date.now();
          await handleTick(price);
        } else {
          console.debug('[TICK] Price not ready.');
        }
      } catch (e) {
        console.warn(`[POLL] Failed to get price: ${e.message}`);
      }
    }, pollIntervalMs);

    // 9️⃣ Unified connection watchdog (every 15s)
    setInterval(async () => {
      if (reconnecting) return;
      try {
        const price = connection?.terminalState?.price(SYMBOL);
        const synced = connection?.synchronized;
        if (!price || price.bid == null || price.ask == null || !synced) {
          reconnecting = true;
          console.warn('[METAAPI] Lost feed or desynced — revalidating connection...');
          await ensureConnection();
          reconnecting = false;
        }
      } catch (e) {
        reconnecting = false;
        console.error('[METAAPI] Watchdog error:', e.message);
      }
    }, 15000);

    // 🔧 Reconnection helper (used by watchdog)
    async function ensureConnection() {
      try {
        if (account.state !== 'DEPLOYED') {
          console.log('[METAAPI] Account not deployed — deploying...');
          await account.deploy();
          await account.waitConnected();
        }

        if (account.connectionStatus !== 'CONNECTED') {
          console.log('[METAAPI] Waiting for broker connection...');
          await account.waitConnected();
        }

        connection = account.getStreamingConnection();
        await connection.connect();
        await connection.waitSynchronized();
        await connection.subscribeToMarketData(SYMBOL);
        console.log(`[METAAPI] ✅ Reconnected & resynchronized for ${SYMBOL}`);
      } catch (e) {
        console.error('[METAAPI] ensureConnection() failed:', e.message);
      }
    }

    // 🔁 Health report every hour
    setInterval(async () => {
      try {
        const uptimeHours = (process.uptime() / 3600).toFixed(1);
        const openPositions = await safeGetPositions();
        const totalTrades = Object.keys(openPairs).length;

        console.log(`[HEALTH] ⏱️ ${uptimeHours}h | Candles: M1=${candlesM1.length}, M5=${candlesM5.length}, M30=${candlesM30.length}`);
        await sendTelegram(
          `📊 *BOT HEALTH REPORT*\n━━━━━━━━━━━━━━━\n🕒 *Uptime:* ${uptimeHours}h\n📈 *Candles:* M1=${candlesM1.length}, M5=${candlesM5.length}, M30=${candlesM30.length}\n📊 *Open Trades:* ${openPositions.length} (${totalTrades} tracked)\n💰 *Balance:* ${accountBalance?.toFixed(2)}`,
          { parse_mode: 'Markdown' }
        );

        if (Date.now() - lastTickTime > 30000) {
          console.warn(`⚠️ Health Check: No tick for 30s, last tick at ${new Date(lastTickTime).toLocaleTimeString()}`);
        }
      } catch (e) {
        console.warn('[HEALTH] Error:', e.message);
      }
    }, 60 * 60 * 1000);

  } catch (err) {
    console.error(`[BOT] Fatal connection error: ${err.message || err}`);

    // --- Maintenance alert ---
    if (!lastDisconnectTime) lastDisconnectTime = Date.now();
    const disconnectedFor = Date.now() - lastDisconnectTime;
    if (disconnectedFor >= MAINTENANCE_ALERT_THRESHOLD && !maintenanceAlertSent) {
      maintenanceAlertSent = true;
      await sendTelegram(
        `⚠️ *BROKER CONNECTION ALERT*\n━━━━━━━━━━━━━━━\n📡 *Status:* Disconnected for more than 30 minutes\n🔧 Possible broker maintenance\n🕒 ${new Date().toLocaleTimeString()}`,
        { parse_mode: 'Markdown' }
      );
    }

    console.log(`[BOT] Retrying connection in ${(retryDelay / 60000).toFixed(1)} minutes...`);
    await delay(retryDelay);
    retryDelay = Math.min(retryDelay * 1.5, MAX_DELAY);

    // restart after delay (non-recursive)
    setTimeout(startBot, 0);
    return;
  }
}




 

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
