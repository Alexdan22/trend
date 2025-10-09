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
const METAAPI_TOKEN = process.env.METAAPI_TOKEN || "REPLACE_WITH_TOKEN";
const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID || "REPLACE_WITH_ACCOUNT_ID";
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
const STRONG_TREND_BBW = 0.035;
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
let closesM30 = [], highsM30 = [], lowsM30 = [];
let closesM5 = [], highsM5 = [], lowsM5 = [];
let closesM1 = [], highsM1 = [], lowsM1 = [];
let lastSignal = null; // {type, m5CandleTime, time}
let openTradeRecords = {}; // ticket -> metadata

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

function determineMarketTypeFromBB(values, bbArray) {
  if (!bbArray.length || values.length === 0) return "sideways";
  const lastBB = bbArray[bbArray.length - 1];
  let closeAboveMid = 0;
  for (let i = 0; i < Math.min(values.length, bbArray.length); i++) {
    if (values[i] > bbArray[i].middle) closeAboveMid++;
  }
  const percentAbove = closeAboveMid / Math.min(values.length, bbArray.length);
  const bbw = (lastBB.upper - lastBB.lower) / lastBB.middle;
  if (bbw > STRONG_TREND_BBW && percentAbove > 0.6) return "uptrend";
  if (bbw > STRONG_TREND_BBW && percentAbove < 0.4) return "downtrend";
  if (bbw > 0.02 && percentAbove > 0.6) return "uptrend";
  if (bbw > 0.02 && percentAbove < 0.4) return "downtrend";
  return "sideways";
}

// --------------------- HELPERS: Money & Lot sizing ---------------------
function roundLot(lot) {
  return Math.max(MIN_LOT, parseFloat(lot.toFixed(LOT_ROUND)));
}

function computeAllowedRiskForNewTrade(currentOpenCount) {
  const used = Object.values(openTradeRecords).reduce((s, r) => s + (r.riskPercent || 0), 0);
  const remaining = Math.max(0, MAX_TOTAL_RISK - used);
  const remainingSlots = Math.max(1, MAX_OPEN_TRADES - currentOpenCount);
  // split remaining among remaining slots but cap by DEFAULT
  return Math.min(DEFAULT_RISK_PER_NEW_TRADE, remaining / remainingSlots);
}

function calculateLotFromRisk(balance, riskPercent, slPips, pipValue = 1.0) {
  const riskAmount = balance * riskPercent;
  if (slPips <= 0) return MIN_LOT;
  const lot = riskAmount / (slPips * pipValue);
  return roundLot(lot);
}

// --------------------- ROBUST EXECUTION HELPERS (from test_order_execution.js) ---------------------
function safeLog(...args) { console.log(...args); }

// safeGetPrice - uses streaming terminalState if available
async function safeGetPrice(symbol) {
  try {
    if (connection?.terminalState) {
      const p = connection.terminalState.price(symbol);
      if (p && p.bid != null && p.ask != null) return p;
    }
  } catch (e) {}
  // fallback: attempt account.getSymbolPrice or connection.getSymbolPrice
  try {
    if (connection && typeof connection.getSymbolPrice === 'function') {
      return await connection.getSymbolPrice(symbol);
    }
  } catch (e) {}
  try {
    if (account && typeof account.getSymbolPrice === 'function') {
      return await account.getSymbolPrice(symbol);
    }
  } catch (e) {}
  return null;
}

// safeGetAccountBalance - tolerant retrieval
async function safeGetAccountBalance() {
  try {
    if (connection?.terminalState?.accountInformation?.balance != null) {
      return connection.terminalState.accountInformation.balance;
    }
  } catch (e) {}
  try {
    if (account?._data?.balance != null) return account._data.balance;
  } catch (e) {}
  try {
    if (metastatsApi?.getMetrics) {
      const metrics = await metastatsApi.getMetrics(ACCOUNT_ID);
      if (metrics?.balance || metrics?.equity) return metrics.balance || metrics.equity;
    }
  } catch (e) {}
  return 0;
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

// safeModifyPosition - attempt common modify methods
async function safeModifyPosition(positionId, params) {
  try {
    if (connection && typeof connection.modifyPosition === 'function') return await connection.modifyPosition(positionId, params);
    if (connection && typeof connection.modifyPositionByTicket === 'function') return await connection.modifyPositionByTicket(positionId, params);
    if (account && typeof account.modifyPosition === 'function') return await account.modifyPosition(positionId, params);
  } catch (e) {
    safeLog(`[MODIFY] Failed for ${positionId}:`, e.message || e);
    throw e;
  }
  throw new Error('No supported modifyPosition method found');
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
function pushAndTrim(arr, value, maxLen = 400) {
  arr.push(value);
  if (arr.length > maxLen) arr.shift();
}

function onCandle(candle) {
  if (!candle) return;
  if (candle.symbol !== SYMBOL) return;
  const tf = candle.timeframe;
  const { high, low, close } = candle;
  if (tf === '30m') { pushAndTrim(closesM30, close); pushAndTrim(highsM30, high); pushAndTrim(lowsM30, low); }
  else if (tf === '5m') { pushAndTrim(closesM5, close); pushAndTrim(highsM5, high); pushAndTrim(lowsM5, low); }
  else if (tf === '1m') { pushAndTrim(closesM1, close); pushAndTrim(highsM1, high); pushAndTrim(lowsM1, low); }

  if (closesM30.length >= 30 && closesM5.length >= 30 && closesM1.length >= 30) {
    const m5Time = (tf === '5m') ? candle.time : null;
    checkStrategy(m5Time).catch(err => console.error('checkStrategy err:', err));
  }
}

// --------------------- CORE: Strategy & Execution ---------------------
async function checkStrategy(m5CandleTime = null) {
  const ind30 = calculateIndicators(closesM30, highsM30, lowsM30);
  const ind5 = calculateIndicators(closesM5, highsM5, lowsM5);
  const ind1 = calculateIndicators(closesM1, highsM1, lowsM1);

  const higherTrend = determineMarketTypeFromBB(closesM30, ind30.bb || []);
  const lastRSI_M5 = ind5.rsi.at(-1);
  const lastStoch_M5 = ind5.stochastic.at(-1);
  const prevStoch_M5 = ind5.stochastic.at(-2);
  const lastRSI_M1 = ind1.rsi.at(-1);
  const lastStoch_M1 = ind1.stochastic.at(-1);
  const lastATR_M5 = ind5.atr.at(-1) || 0;

  if (!lastStoch_M5 || !prevStoch_M5 || !lastStoch_M1) return; // safety

  console.log(`[STRAT] M30:${higherTrend} | M5 RSI:${lastRSI_M5?.toFixed(2)} Stoch:${lastStoch_M5?.k?.toFixed(2)} | M1 RSI:${lastRSI_M1?.toFixed(2)} Stoch:${lastStoch_M1?.k?.toFixed(2)}`);
  
  // compute current open positions
  const openPositions = await safeGetPositions();
  // sync our tracking map with existing positions
  await syncOpenTradeRecordsWithPositions(openPositions);

  // allow new trade if open positions < MAX_OPEN_TRADES
  if (openPositions.length >= MAX_OPEN_TRADES) {
    await monitorOpenTrades(ind30, ind5, ind1);
    return;
  }

  // compute allowed risk for this new trade
  const allowedRiskPercent = computeAllowedRiskForNewTrade(openPositions.length);
  if (allowedRiskPercent <= 0) {
    console.log('No remaining risk budget for new trades.');
    await monitorOpenTrades(ind30, ind5, ind1);
    return;
  }

  // Define M5 triggers
  const buyM5Trigger = (prevStoch_M5.k < 20 && lastStoch_M5.k >= 20 && lastRSI_M5 < 40);
  const buyM1Confirm = (lastRSI_M1 < 40 && lastStoch_M1.k < 20);
  const sellM5Trigger = (prevStoch_M5.k > 80 && lastStoch_M5.k <= 80 && lastRSI_M5 > 60);
  const sellM1Confirm = (lastRSI_M1 > 60 && lastStoch_M1.k > 80);

  // --- POTENTIAL ZONE ALERTS ---
  // BUY Zone
  if (
    higherTrend === 'uptrend' &&
    buyM5Trigger &&
    !buyM1Confirm &&
    (!lastZoneSignal || lastZoneSignal.type !== 'BUY' || lastZoneSignal.candleTime !== m5CandleTime)
  ) {
    await sendTelegram(
      `⚡ *POTENTIAL BUY ZONE DETECTED*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📊 *Trend:* ${higherTrend.toUpperCase()}\n` +
      `📍 *Trigger:* M5 bullish setup detected\n` +
      `💡 Waiting for M1 confirmation...\n` +
      `⏰ ${new Date().toLocaleTimeString()}`,
      { parse_mode: 'Markdown' }
    );
    lastZoneSignal = { type: 'BUY', candleTime: m5CandleTime };
  }

  // SELL Zone
  if (
    higherTrend === 'downtrend' &&
    sellM5Trigger &&
    !sellM1Confirm &&
    (!lastZoneSignal || lastZoneSignal.type !== 'SELL' || lastZoneSignal.candleTime !== m5CandleTime)
  ) {
    await sendTelegram(
      `⚡ *POTENTIAL SELL ZONE DETECTED*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📊 *Trend:* ${higherTrend.toUpperCase()}\n` +
      `📍 *Trigger:* M5 bearish setup detected\n` +
      `💡 Waiting for M1 confirmation...\n` +
      `⏰ ${new Date().toLocaleTimeString()}`,
      { parse_mode: 'Markdown' }
    );
    lastZoneSignal = { type: 'SELL', candleTime: m5CandleTime };
  }


  // determine sl price using ATR (dynamic)
  const slDistance = lastATR_M5 * ATR_SL_MULTIPLIER;
  const minSlDistance = 20 * 0.1; // 20 pips * 0.1
  const effectiveSl = Math.max(slDistance || 0, minSlDistance);

  // risk -> convert slDistance in price to pips estimate for lot sizing: pips = slPrice / 0.1
  const slPips = effectiveSl / 0.1;

  // ensure we have a reasonable accountBalance
  if (!accountBalance || accountBalance === 0) {
    accountBalance = await safeGetAccountBalance();
  }

  // lot calculation
  const lot = calculateLotFromRisk(accountBalance, allowedRiskPercent, slPips, 1.0);

  // extra TP rules: if M30 is strong (very strong), allow larger R:R
  const trr = (function() {
    try {
      const bbw30 = (ind30.bb.at(-1).upper - ind30.bb.at(-1).lower) / ind30.bb.at(-1).middle;
      if (determineMarketTypeFromBB(closesM30, ind30.bb) === 'uptrend' || determineMarketTypeFromBB(closesM30, ind30.bb) === 'downtrend') {
        if (bbw30 > STRONG_TREND_BBW) return 3.0;
        return 2.0;
      }
    } catch (e) {}
    return 1.5;
  })();

  // Compose SL/TP price levels
  const price = await safeGetPrice(SYMBOL); // {bid, ask}
  if (!price) {
    console.warn('[STRAT] Price unavailable, skipping trade attempt.');
    await monitorOpenTrades(ind30, ind5, ind1);
    return;
  }
  const ask = price.ask, bid = price.bid;

  // BUY path
  if (higherTrend === 'uptrend' && buyM5Trigger && buyM1Confirm) {
    const candleTime = m5CandleTime || new Date().toISOString();
    if (!canTakeTrade('BUY', candleTime)) {
      console.log('BUY blocked by cooldown/duplicate guard.');
    } else {
      const slPrice = ask - effectiveSl;
      const tpPrice = ask + effectiveSl * trr;
      if ((openPositions.length < MAX_OPEN_TRADES) && allowedRiskPercent > 0) {
        try {
          const res = await safePlaceMarketOrder('BUY', lot, slPrice, tpPrice);
          console.log('BUY order placed:', res);
          await registerNewOpenTrade(res, 'BUY', lot, slPrice, tpPrice, allowedRiskPercent);
          lastSignal = { type: 'BUY', m5CandleTime: candleTime, time: new Date().toISOString() };
        } catch (e) {
          console.error('BUY place order failed:', e.message || e);
        }
      }
    }
  }

  // SELL path
  if (higherTrend === 'downtrend' && sellM5Trigger && sellM1Confirm) {
    const candleTime = m5CandleTime || new Date().toISOString();
    if (!canTakeTrade('SELL', candleTime)) {
      console.log('SELL blocked by cooldown/duplicate guard.');
    } else {
      const slPrice = bid + effectiveSl;
      const tpPrice = bid - effectiveSl * trr;
      if ((openPositions.length < MAX_OPEN_TRADES) && allowedRiskPercent > 0) {
        try {
          const res = await safePlaceMarketOrder('SELL', lot, slPrice, tpPrice);
          console.log('SELL order placed:', res);
          await registerNewOpenTrade(res, 'SELL', lot, slPrice, tpPrice, allowedRiskPercent);
          lastSignal = { type: 'SELL', m5CandleTime: candleTime, time: new Date().toISOString() };
        } catch (e) {
          console.error('SELL place order failed:', e.message || e);
        }
      }
    }
  }

  // Always monitor open trades for partial close / trailing / trend-weaken close
  await monitorOpenTrades(ind30, ind5, ind1);
}

// --------------------- GUARDS & RECORDING ---------------------
async function getOpenPositions() {
  return await safeGetPositions();
}

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

async function registerNewOpenTrade(res, side, lot, sl, tp, riskPercent) {
  // res should contain info about created order and/or position.
  let ticket = (res && (res.orderId || res.positionId || res.ticket || res.id)) || `local-${Date.now()}`;
  let entryPrice;
  try {
    entryPrice = (side === 'BUY') ? (res && res.price) || (await safeGetPrice(SYMBOL)).ask : (res && res.price) || (await safeGetPrice(SYMBOL)).bid;
  } catch (e) {
    entryPrice = null;
  }

  openTradeRecords[ticket] = {
    ticket,
    side,
    lot,
    sl,
    tp,
    entryPrice,
    riskPercent,
    openedAt: new Date().toISOString(),
    partialClosed: false,
    trailedTo: null
  };

  console.log('Registered trade:', openTradeRecords[ticket]);

  await sendTelegram(
  `🟩 *NEW TRADE OPENED*\n` +
  `━━━━━━━━━━━━━━━\n` +
  `📈 *Type:* ${side}\n` +
  `💰 *Lot:* ${lot}\n` +
  `💵 *Entry:* ${entryPrice?.toFixed(3)}\n` +
  `🛑 *Stop Loss:* ${sl?.toFixed(3)}\n` +
  `🎯 *Take Profit:* ${tp?.toFixed(3)}\n` +
  `⚖️ *Risk:* ${(riskPercent * 100).toFixed(1)}%\n` +
  `🕒 *Time:* ${new Date().toLocaleTimeString()}`,
  { parse_mode: 'Markdown' }
);

}

async function syncOpenTradeRecordsWithPositions(positions) {
  const currentTickets = positions.map(p => p.positionId || p.ticket || p.id).filter(Boolean);

  // remove local records that are no longer open
  for (let t of Object.keys(openTradeRecords)) {
    if (!currentTickets.includes(t)) {
      console.log('Previously tracked trade closed externally:', t);
      delete openTradeRecords[t];
    }
  }

  // add any positions we don't know about
  for (let pos of positions) {
    const ticket = pos.positionId || pos.ticket || pos.id;
    if (!ticket) continue;
    if (!openTradeRecords[ticket]) {
      openTradeRecords[ticket] = {
        ticket,
        side: pos.side || (pos.type === 'buy' ? 'BUY' : 'SELL') || 'UNKNOWN',
        lot: pos.volume || pos.lots || pos.size || 0,
        sl: pos.stopLoss || null,
        tp: pos.takeProfit || null,
        entryPrice: pos.openPrice || pos.averagePrice || null,
        riskPercent: 0, // unknown
        openedAt: pos.openTime || new Date().toISOString(),
        partialClosed: false,
        trailedTo: null
      };
      console.log('Synced external position:', ticket, openTradeRecords[ticket]);
    }
  }
}

// --------------------- MONITOR: partial close, trailing, close on trend-weaken ---------------------
async function monitorOpenTrades(ind30, ind5, ind1) {
  try {
    const positions = await safeGetPositions();
    // sync first
    await syncOpenTradeRecordsWithPositions(positions);

    // recompute higherTrend and a measure of strength
    const higherTrend = determineMarketTypeFromBB(closesM30, ind30.bb || []);
    const trendStrong = higherTrend !== 'sideways';

    for (let pos of positions) {
      // extract identifier
      const ticket = pos.positionId || pos.ticket || pos.id;
      const rec = openTradeRecords[ticket] || null;
      const side = rec ? rec.side : (pos.side || (pos.type === 'buy' ? 'BUY' : 'SELL'));
      const volume = rec ? rec.lot : (pos.volume || pos.lots || pos.size);
      const entry = rec ? rec.entryPrice : (pos.openPrice || pos.averagePrice || pos.price);
      const sl = rec ? rec.sl : pos.stopLoss;
      const tp = rec ? rec.tp : pos.takeProfit;

      // compute current price & unrealized pips to TP
      const price = await safeGetPrice(SYMBOL);
      if (!price) continue;
      const currentPrice = (side === 'BUY') ? price.bid : price.ask; // if long, profit at bid
      if (!tp || !entry) continue;

      const totalDistanceToTP = Math.abs(tp - entry);
      const currentDistanceToTP = Math.abs(tp - currentPrice);
      const progress = 1 - (currentDistanceToTP / totalDistanceToTP); // 0 -> not moved, 1 -> hit

      // Partial close at 50% TP: if not yet partialClosed and progress >= 0.5
      if (!rec?.partialClosed && progress >= 0.5) {
        const halfVolume = Math.max(MIN_LOT, parseFloat((volume / 2).toFixed(LOT_ROUND)));
        try {
          const closeRes = await safeClosePosition(ticket, halfVolume);
          if (closeRes.ok) {
            if (rec) {
              rec.partialClosed = true;
              rec.lot = parseFloat((volume - halfVolume).toFixed(LOT_ROUND));
            }
            console.log(`Partial close executed for ${ticket}: closed ${halfVolume}`);

            await sendTelegram(
            `🟠 *PARTIAL CLOSE EXECUTED*\n` +
            `━━━━━━━━━━━━━━━\n` +
            `🎫 *Ticket:* ${ticket}\n` +
            `📉 *Closed:* ${halfVolume}\n` +
            `📈 *Remaining:* ${rec?.lot}\n` +
            `💰 *Side:* ${rec?.side}\n` +
            `🕒 ${new Date().toLocaleTimeString()}`,
            { parse_mode: 'Markdown' }
          );

          } else {
            console.warn('Partial close failed for', ticket, closeRes.error && closeRes.error.message);
          }
        } catch (e) {
          console.warn('Partial close error:', e.message || e);
        }
      }

      // Trailing logic: move SL up to protect profits while trend remains strong
      if (trendStrong) {
        const atr5 = ind5.atr.at(-1) || 0;
        if (atr5 > 0) {
          let targetSl;
          if (side === 'BUY') {
            targetSl = currentPrice - atr5 * 1.0;
            if (sl == null || targetSl > sl + 1e-9) {
              try {
                await safeModifyPosition(ticket, { stopLoss: targetSl });
                if (rec) { rec.sl = targetSl; rec.trailedTo = targetSl; }
                console.log(`Tightened SL for ${ticket} to ${targetSl}`);

                await sendTelegram(
                `🔄 *TRAILING STOP UPDATED*\n` +
                `━━━━━━━━━━━━━━━\n` +
                `🎫 *Ticket:* ${ticket}\n` +
                `📈 *Side:* ${rec?.side}\n` +
                `🆕 *New SL:* ${targetSl.toFixed(3)}\n` +
                `🕒 ${new Date().toLocaleTimeString()}`,
                { parse_mode: 'Markdown' }
              );

              } catch (e) {
                // ignore if modify not supported
              }
            }
          } else {
            targetSl = currentPrice + atr5 * 1.0;
            if (sl == null || targetSl < sl - 1e-9) {
              try {
                await safeModifyPosition(ticket, { stopLoss: targetSl });
                if (rec) { rec.sl = targetSl; rec.trailedTo = targetSl; }
                console.log(`Tightened SL for ${ticket} to ${targetSl}`);

                await sendTelegram(
                `🔄 *TRAILING STOP UPDATED*\n` +
                `━━━━━━━━━━━━━━━\n` +
                `🎫 *Ticket:* ${ticket}\n` +
                `📈 *Side:* ${rec?.side}\n` +
                `🆕 *New SL:* ${targetSl.toFixed(3)}\n` +
                `🕒 ${new Date().toLocaleTimeString()}`,
                { parse_mode: 'Markdown' }
              );

              } catch (e) {}
            }
          }
        }
      } else {
        // If trend is no longer strong -> close remaining lot (exit trade)
        if (rec && rec.lot > 0) {
          try {
            const closeRes = await safeClosePosition(ticket, rec.lot);
            if (closeRes.ok) {
              console.log(`Closed ${ticket} due to trend weakening.`);

              await sendTelegram(
              `🔻 *TRADE CLOSED (TREND WEAKENED)*\n` +
              `━━━━━━━━━━━━━━━\n` +
              `🎫 *Ticket:* ${ticket}\n` +
              `📈 *Side:* ${rec?.side}\n` +
              `💵 *Lot Closed:* ${rec?.lot}\n` +
              `🕒 ${new Date().toLocaleTimeString()}`,
              { parse_mode: 'Markdown' }
            );

              delete openTradeRecords[ticket];
            } else {
              console.warn('Error closing trade on trend weaken:', ticket, closeRes.error && closeRes.error.message);
            }
          } catch (e) {
            console.warn('Error closing trade on trend weaken:', e.message || e);
          }
        }
      }
    }
  } catch (e) {
    console.error('monitorOpenTrades error:', e.message || e);
  }
}

// --------------------- TICK → CANDLE AGGREGATOR ---------------------
const aggregators = {
  '1m': null,
  '5m': null,
  '30m': null
};

function floorTime(date, timeframe) {
  const d = new Date(date);
  if (timeframe === '1m') d.setSeconds(0, 0);
  if (timeframe === '5m') d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  if (timeframe === '30m') d.setMinutes(Math.floor(d.getMinutes() / 30) * 30, 0, 0);
  return d.getTime();
}

function handleTick(tick) {
  const mid = (tick.bid + tick.ask) / 2;
  const now = new Date(tick.time);

   // --- Save tick to local cache ---
  try {
    const entry = { bid: tick.bid, ask: tick.ask, time: tick.time };
    let existing = [];
    if (fs.existsSync(TICK_CACHE_FILE)) {
      existing = JSON.parse(fs.readFileSync(TICK_CACHE_FILE, 'utf8'));
    }
    existing.push(entry);
    if (existing.length > 5000) existing.splice(0, existing.length - 5000); // keep last 5k ticks

    // Ensure directory exists before writing
    const dir = path.dirname(TICK_CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(TICK_CACHE_FILE, JSON.stringify(existing));
  } catch (e) {
    console.warn(`[CACHE] Failed to write tick cache: ${e.message}`);
  }

  ['1m', '5m', '30m'].forEach(tf => {
    const bucketTime = floorTime(now, tf);

    if (!aggregators[tf] || aggregators[tf].time !== bucketTime) {
      // Finalize previous candle
      if (aggregators[tf]) {
        onCandle({ 
          symbol: SYMBOL, 
          timeframe: tf, 
          time: new Date(aggregators[tf].time).toISOString(),
          open: aggregators[tf].open, 
          high: aggregators[tf].high, 
          low: aggregators[tf].low, 
          close: aggregators[tf].close 
        });
      }
      // Start new candle
      aggregators[tf] = { time: bucketTime, open: mid, high: mid, low: mid, close: mid };
    } else {
      // Update current candle
      aggregators[tf].close = mid;
      if (mid > aggregators[tf].high) aggregators[tf].high = mid;
      if (mid < aggregators[tf].low) aggregators[tf].low = mid;
    }
  });
}

async function preloadHistoricalCandlesFromTwelveData(symbol = 'XAU/USD') {
  console.log(`[INIT] Fetching historical candles for ${symbol} from Twelve Data...`);
  const API_KEY = process.env.TWELVE_DATA_KEY; // get your free key from twelvedata.com
  const tfMap = { '1m': '1min', '5m': '5min', '30m': '30min' };

  for (const [tf, apiTf] of Object.entries(tfMap)) {
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${apiTf}&outputsize=200&apikey=${API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      const candles = data?.values?.reverse(); // oldest → newest

      if (Array.isArray(candles) && candles.length > 0) {
        const closes = candles.map(c => parseFloat(c.close));
        const highs = candles.map(c => parseFloat(c.high));
        const lows = candles.map(c => parseFloat(c.low));

        if (tf === '1m') { closesM1 = closes; highsM1 = highs; lowsM1 = lows; }
        if (tf === '5m') { closesM5 = closes; highsM5 = highs; lowsM5 = lows; }
        if (tf === '30m') { closesM30 = closes; highsM30 = highs; lowsM30 = lows; }

        console.log(`[PRELOAD] ${symbol} | ${tf} | Loaded ${candles.length} candles from Twelve Data`);
      }
    } catch (e) {
      console.warn(`[PRELOAD] Failed to load ${tf} data: ${e.message}`);
    }
  }

  console.log('[PRELOAD] External data preload complete.');
}

// --------------------- MAIN LOOP ---------------------
(async () => {
  try {
    api = new MetaApi(METAAPI_TOKEN);
    metastatsApi = new MetaStats(METAAPI_TOKEN);
    account = await api.metatraderAccountApi.getAccount(ACCOUNT_ID);

    // Deploy account if required
    if (account.state !== 'DEPLOYED') {
      console.log('Deploying account...');
      await account.deploy();
      await account.waitConnected();
    }

    // Connect to MetaApi shared server
    connection = account.getStreamingConnection();
    await connection.connect();
    if (typeof connection.waitSynchronized === 'function') {
      await connection.waitSynchronized();
    }

    await preloadHistoricalCandlesFromTwelveData('XAU/USD');

    // Fetch account info
    const terminalState = connection.terminalState;
    const accountInfo = terminalState.accountInformation || {};
    accountBalance = accountInfo.balance || 0;
    console.log('✅ Connected to MetaApi. Balance:', accountBalance);

    await sendTelegram(
    `✅ *BOT CONNECTED TO METAAPI*\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📊 Symbol: ${SYMBOL}\n` +
    `💰 Balance: ${accountBalance.toFixed(2)}\n` +
    `🕒 ${new Date().toLocaleTimeString()}`,
    { parse_mode: 'Markdown' }
  );


    // Subscribe to tick data
    try {
      console.log(`[INIT] Subscribing to ${SYMBOL} tick stream...`);
      if (typeof connection.subscribeToMarketData === 'function') {
        await connection.subscribeToMarketData(SYMBOL);
        console.log(`[CANDLES] Subscribed to market data for ${SYMBOL}`);
      } else {
        console.log(`[CANDLES] subscribeToMarketData not available on this connection object.`);
      }
    } catch (e) {
      console.warn(`❌ Market data subscription failed: ${e.message}`);
    }

    // --- Tick polling + heartbeat monitoring ---
    let lastTickTime = Date.now();
    const pollIntervalMs = 2000;     // tick polling frequency
    const heartbeatMs = 30000;       // no-tick timeout
    let reconnecting = false;

    const pollTicks = async () => {
      try {
        const price = connection.terminalState && typeof connection.terminalState.price === 'function' ? connection.terminalState.price(SYMBOL) : null;
        if (price && price.bid != null && price.ask != null) {
          lastTickTime = Date.now();
          // Feed tick into candle aggregator
          if (typeof handleTick === 'function') handleTick(price);
        }
      } catch (e) {
        console.warn(`[POLL] Failed to get price: ${e.message}`);
      }
    };

    const watchdog = async () => {
      const diff = Date.now() - lastTickTime;
      if (diff > heartbeatMs && !reconnecting) {
        reconnecting = true;
        console.warn(`⚠️ No ticks for ${heartbeatMs / 1000}s — reconnecting...`);
        try {
          await connection.connect();
          if (typeof connection.waitSynchronized === 'function') {
            await connection.waitSynchronized();
          }
          if (typeof connection.subscribeToMarketData === 'function') {
            await connection.subscribeToMarketData(SYMBOL);
          }
          console.log(`[RECONNECTED] Resubscribed to ${SYMBOL} tick stream.`);
          lastTickTime = Date.now();
        } catch (err) {
          console.error('❌ Reconnect attempt failed:', err.message || err);
        } finally {
          reconnecting = false;
        }
      }
    };

    setInterval(pollTicks, pollIntervalMs);
    setInterval(watchdog, 5000);

    // --- Periodic trade monitor ---
    setInterval(async () => {
      const ind30 = calculateIndicators(closesM30, highsM30, lowsM30);
      const ind5 = calculateIndicators(closesM5, highsM5, lowsM5);
      const ind1 = calculateIndicators(closesM1, highsM1, lowsM1);
      await monitorOpenTrades(ind30, ind5, ind1);
    }, CHECK_INTERVAL_MS);

    // Memory cleanup for long runs
    setInterval(() => {
      closesM1.splice(0, closesM1.length - 200);
      closesM5.splice(0, closesM5.length - 200);
      closesM30.splice(0, closesM30.length - 200);
    }, 60 * 60 * 1000); // every hour

    // Hourly health monitor
    setInterval(async () => {
      try {
        const uptimeHours = (process.uptime() / 3600).toFixed(1);
        const openPositions = await safeGetPositions();
        const totalTrades = Object.keys(openTradeRecords).length;
        const tickHealth = new Date(Date.now() - lastTickTime).getSeconds();

        console.log(
          `\n[HEALTH] ⏱️ Uptime: ${uptimeHours}h | 🟢 Candles: M1=${closesM1.length}, M5=${closesM5.length}, M30=${closesM30.length} | 📊 Open Trades: ${openPositions.length} (${totalTrades} tracked)`
        );

        await sendTelegram(
        `📊 *BOT HEALTH REPORT*\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🕒 *Uptime:* ${uptimeHours}h\n` +
        `📈 *Candles:* M1=${closesM1.length}, M5=${closesM5.length}, M30=${closesM30.length}\n` +
        `📊 *Open Trades:* ${openPositions.length} (${totalTrades} tracked)\n` +
        `💰 *Balance:* ${accountBalance?.toFixed(2)}`,
        { parse_mode: 'Markdown' }
      );


        if (Date.now() - lastTickTime > 30000) {
          console.warn(`⚠️ Health Check: No tick for 30s, last tick at ${new Date(lastTickTime).toLocaleTimeString()}`);
        }
      } catch (e) {
        console.warn(`[HEALTH] Error: ${e.message || e}`);
      }
    }, 60 * 60 * 1000); // every hour

    console.log('🤖 Bot ready and running. Listening to aggregated candles for', SYMBOL);

  } catch (e) {
    console.error('❌ Fatal error:', e.message || e);
  }
})();

process.on('SIGINT', async () => {
  console.log('🛑 Gracefully shutting down...');
  try {
    if (connection && typeof connection.unsubscribeFromMarketData === 'function') await connection.unsubscribeFromMarketData(SYMBOL);
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
