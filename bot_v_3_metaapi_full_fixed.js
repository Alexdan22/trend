// bot_v3_metaapi_full_ready_full.js
// Full Triple-timeframe pullback/trend bot with MetaApi execution
// Includes: trade management (partial close, trailing stop, external sync), retries, and symbol listing

const MetaApi = require('metaapi.cloud-sdk').default;
const ti = require('technicalindicators');

// --------------------- CONFIG ---------------------
const METAAPI_TOKEN = process.env.METAAPI_TOKEN || "REPLACE_WITH_TOKEN";
const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID || "REPLACE_WITH_ACCOUNT_ID";
const SYMBOL = "XAUUSD"; // Update this depending on your broker (e.g. XAUUSDm, GOLD)

const MAX_OPEN_TRADES = 3;
const MAX_TOTAL_RISK = 0.06;
const DEFAULT_RISK_PER_NEW_TRADE = 0.02;
const COOLDOWN_MINUTES = 10;
const MIN_LOT = 0.01;
const LOT_ROUND = 2;
const ATR_PERIOD = 14;
const ATR_SL_MULTIPLIER = 1.2;
const STRONG_TREND_BBW = 0.035;
const CHECK_INTERVAL_MS = 10_000;

// --------------------- STATE ---------------------
let api, account, connection;
let accountBalance = 0;
let closesM30 = [], highsM30 = [], lowsM30 = [];
let closesM5 = [], highsM5 = [], lowsM5 = [];
let closesM1 = [], highsM1 = [], lowsM1 = [];
let lastSignal = null;
let openTradeRecords = {};

// --------------------- HELPERS ---------------------
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

function roundLot(lot) {
  return Math.max(MIN_LOT, parseFloat(lot.toFixed(LOT_ROUND)));
}

function computeAllowedRiskForNewTrade(currentOpenCount) {
  const used = Object.values(openTradeRecords).reduce((s, r) => s + (r.riskPercent || 0), 0);
  const remaining = Math.max(0, MAX_TOTAL_RISK - used);
  const remainingSlots = Math.max(1, MAX_OPEN_TRADES - currentOpenCount);
  return Math.min(DEFAULT_RISK_PER_NEW_TRADE, remaining / remainingSlots);
}

function calculateLotFromRisk(balance, riskPercent, slPips, pipValue = 1.0) {
  const riskAmount = balance * riskPercent;
  if (slPips <= 0) return MIN_LOT;
  const lot = riskAmount / (slPips * pipValue);
  return roundLot(lot);
}

// --------------------- SAFE WRAPPERS ---------------------
async function safeGetAccountBalance() {
  try {
    if (connection && typeof connection.getAccountInformation === 'function') {
      const accInfo = await connection.getAccountInformation();
      if (accInfo && accInfo.balance !== undefined) return accInfo.balance;
    }
  } catch {}
  return 0;
}

async function safeGetPositions() {
  try {
    if (connection && typeof connection.getPositions === 'function') return await connection.getPositions();
  } catch {}
  return [];
}

async function safeGetSymbolPrice(symbol) {
  try {
    if (connection && typeof connection.getSymbolPrice === 'function') return await connection.getSymbolPrice(symbol);
  } catch {}
  return { bid: 0, ask: 0 };
}

async function safePlaceMarketOrder(action, lot, slPrice, tpPrice) {
  if (connection) {
    if (action === 'BUY' && typeof connection.createMarketBuyOrder === 'function') {
      return await connection.createMarketBuyOrder(SYMBOL, lot, { stopLoss: slPrice, takeProfit: tpPrice });
    }
    if (action === 'SELL' && typeof connection.createMarketSellOrder === 'function') {
      return await connection.createMarketSellOrder(SYMBOL, lot, { stopLoss: slPrice, takeProfit: tpPrice });
    }
  }
  throw new Error('No supported market order method found on connection');
}

async function safeClosePosition(positionId, volume) {
  if (connection && typeof connection.closePosition === 'function') return await connection.closePosition(positionId, volume);
  throw new Error('No supported closePosition method found');
}

async function safeModifyPosition(positionId, params = {}) {
  if (connection && typeof connection.modifyPosition === 'function') return await connection.modifyPosition(positionId, params);
  throw new Error('No supported modifyPosition method found');
}

// --------------------- CANDLE HANDLER ---------------------
function pushAndTrim(arr, value, maxLen = 400) {
  arr.push(value);
  if (arr.length > maxLen) arr.shift();
}

function onCandle(candle) {
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

// --------------------- STRATEGY ---------------------
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

  if (!lastStoch_M5 || !prevStoch_M5 || !lastStoch_M1) return;

  console.log(`[STRAT] M30:${higherTrend} | M5 RSI:${lastRSI_M5?.toFixed(2)} | M1 RSI:${lastRSI_M1?.toFixed(2)}`);

  const openPositions = await getOpenPositions();
  await syncOpenTradeRecordsWithPositions(openPositions);
  if (openPositions.length >= MAX_OPEN_TRADES) {
    await monitorOpenTrades(ind30, ind5, ind1);
    return;
  }

  const allowedRiskPercent = computeAllowedRiskForNewTrade(openPositions.length);
  if (allowedRiskPercent <= 0) return;

  const buyM5Trigger = (prevStoch_M5.k < 20 && lastStoch_M5.k >= 20 && lastRSI_M5 < 40);
  const buyM1Confirm = (lastRSI_M1 < 40 && lastStoch_M1.k < 20);
  const sellM5Trigger = (prevStoch_M5.k > 80 && lastStoch_M5.k <= 80 && lastRSI_M5 > 60);
  const sellM1Confirm = (lastRSI_M1 > 60 && lastStoch_M1.k > 80);

  const slDistance = Math.max(lastATR_M5 * ATR_SL_MULTIPLIER, 2.0);
  const slPips = slDistance / 0.1;
  if (!accountBalance || accountBalance === 0) accountBalance = await safeGetAccountBalance();
  const lot = calculateLotFromRisk(accountBalance, allowedRiskPercent, slPips, 1.0);

  const price = await safeGetSymbolPrice(SYMBOL);
  const ask = price.ask || 0, bid = price.bid || 0;

  if (higherTrend === 'uptrend' && buyM5Trigger && buyM1Confirm) {
    const candleTime = m5CandleTime || new Date().toISOString();
    if (!canTakeTrade('BUY', candleTime)) return;
    const slPrice = ask - slDistance;
    const tpPrice = ask + slDistance * 2;
    try {
      const res = await safePlaceMarketOrder('BUY', lot, slPrice, tpPrice);
      await registerNewOpenTrade(res, 'BUY', lot, slPrice, tpPrice, allowedRiskPercent);
      lastSignal = { type: 'BUY', m5CandleTime: candleTime, time: new Date().toISOString() };
      console.log('BUY order placed');
    } catch (e) { console.error('BUY failed', e.message); }
  }

  if (higherTrend === 'downtrend' && sellM5Trigger && sellM1Confirm) {
    const candleTime = m5CandleTime || new Date().toISOString();
    if (!canTakeTrade('SELL', candleTime)) return;
    const slPrice = bid + slDistance;
    const tpPrice = bid - slDistance * 2;
    try {
      const res = await safePlaceMarketOrder('SELL', lot, slPrice, tpPrice);
      await registerNewOpenTrade(res, 'SELL', lot, slPrice, tpPrice, allowedRiskPercent);
      lastSignal = { type: 'SELL', m5CandleTime: candleTime, time: new Date().toISOString() };
      console.log('SELL order placed');
    } catch (e) { console.error('SELL failed', e.message); }
  }

  await monitorOpenTrades(ind30, ind5, ind1);
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
  let ticket = (res && (res.orderId || res.positionId || res.ticket || res.id)) || `local-${Date.now()}`;
  let entryPrice = null;
  try {
    if (res && typeof res.price !== 'undefined') entryPrice = res.price;
    else {
      const p = await safeGetSymbolPrice(SYMBOL);
      entryPrice = side === 'BUY' ? p.ask : p.bid;
    }
  } catch {}

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
}

async function getOpenPositions() { return await safeGetPositions(); }

async function syncOpenTradeRecordsWithPositions(positions) {
  const currentTickets = positions.map(p => p.positionId || p.ticket || p.id).filter(Boolean);
  for (let t of Object.keys(openTradeRecords)) {
    if (!currentTickets.includes(t)) delete openTradeRecords[t];
  }
  for (let pos of positions) {
    const ticket = pos.positionId || pos.ticket || pos.id;
    if (!ticket) continue;
    if (!openTradeRecords[ticket]) {
      openTradeRecords[ticket] = {
        ticket,
        side: pos.side || (pos.type === 'buy' ? 'BUY' : 'SELL'),
        lot: pos.volume || pos.lots || pos.size || 0,
        sl: pos.stopLoss || null,
        tp: pos.takeProfit || null,
        entryPrice: pos.openPrice || pos.averagePrice || null,
        riskPercent: 0,
        openedAt: pos.openTime || new Date().toISOString(),
        partialClosed: false,
        trailedTo: null
      };
    }
  }
}

async function monitorOpenTrades(ind30, ind5, ind1) {
  try {
    const positions = await getOpenPositions();
    await syncOpenTradeRecordsWithPositions(positions);
    const higherTrend = determineMarketTypeFromBB(closesM30, ind30.bb || []);
    const trendStrong = higherTrend !== 'sideways';

    for (let pos of positions) {
      const ticket = pos.positionId || pos.ticket || pos.id;
      const rec = openTradeRecords[ticket] || null;
      const side = rec ? rec.side : (pos.side || (pos.type === 'buy' ? 'BUY' : 'SELL'));
      const volume = rec ? rec.lot : (pos.volume || pos.lots || pos.size);
      const entry = rec ? rec.entryPrice : (pos.openPrice || pos.averagePrice || pos.price);
      const sl = rec ? rec.sl : pos.stopLoss;
      const tp = rec ? rec.tp : pos.takeProfit;
      const price = await safeGetSymbolPrice(SYMBOL);
      const currentPrice = (side === 'BUY') ? price.bid : price.ask;
      if (!tp || !entry) continue;

      const totalDistanceToTP = Math.abs(tp - entry);
      const currentDistanceToTP = Math.abs(tp - currentPrice);
      const progress = 1 - (currentDistanceToTP / totalDistanceToTP);

      if (rec && !rec.partialClosed && progress >= 0.5) {
        const halfVolume = Math.max(MIN_LOT, parseFloat((volume / 2).toFixed(LOT_ROUND)));
        try {
          await safeClosePosition(ticket, halfVolume);
          rec.partialClosed = true;
          rec.lot = parseFloat((volume - halfVolume).toFixed(LOT_ROUND));
          console.log(`Partial close executed for ${ticket}: closed ${halfVolume}`);
        } catch (e) { console.warn('Partial close failed:', e.message || e); }
      }

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
                console.log(`Tightened SL for ${ticket}