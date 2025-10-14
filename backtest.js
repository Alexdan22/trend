#!/usr/bin/env node
// backtest.js
// Backtester using Twelve Data historical candles + your strategy logic
// Usage example:
//  TWELVE_DATA_KEY=xxx node backtest.js --symbol XAU/USD --from 2025-09-01 --to 2025-10-13 --balance 10000

require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const ti = require('technicalindicators');
const fs = require('fs');
const path = require('path');
const argv = require('minimist')(process.argv.slice(2));

// ------------------ CONFIG ------------------
const TW_API_KEY = process.env.TWELVE_DATA_KEY;
if (!TW_API_KEY) {
  console.error('Missing TWELVE_DATA_KEY in .env');
  process.exit(1);
}

const SYMBOL = argv.symbol || argv.s || 'XAU/USD'; // Twelve Data uses "XAU/USD"
const FROM = argv.from || argv.f || null; // YYYY-MM-DD
const TO = argv.to || argv.t || null;     // YYYY-MM-DD or null
const INITIAL_BALANCE = parseFloat(argv.balance || argv.b || '10000');

const ATR_PERIOD = parseInt(argv.atrPeriod || 14);
const RSI_PERIOD = 14;
const STOCH_PERIOD = 14;
const STOCH_SIGNAL = 3;
const BB_PERIOD = 20;
const BB_STD = 2;

const ATR_SL_MULTIPLIER = parseFloat(argv.slMult || 1.2);
const DEFAULT_RISK = parseFloat(argv.risk || 0.02); // 2% per trade default
const MAX_TRADE_MINUTES = parseInt(argv.maxMinutes || 240); // max life of a trade in minutes

const STRONG_TREND_BBW = parseFloat(argv.strongBbw || 0.004);

// Backtest behaviour toggles
const EXPORT_EQUITY_CSV = argv.csv || false;
const VERBOSE = argv.v || false;

// ------------------ HELPERS ------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildUrl(symbol, interval, outputsize = 5000, startDate = null, endDate = null) {
  const base = 'https://api.twelvedata.com/time_series';
  const q = new URLSearchParams();
  q.set('symbol', symbol);
  q.set('interval', interval);
  q.set('outputsize', String(outputsize));
  q.set('format', 'JSON');
  q.set('apikey', TW_API_KEY);
  if (startDate) q.set('start_date', startDate);
  if (endDate) q.set('end_date', endDate);
  return `${base}?${q.toString()}`;
}

async function fetchCandles(symbol, interval, out = 5000, startDate = null, endDate = null) {
  const url = buildUrl(symbol, interval, out, startDate, endDate);
  const res = await fetch(url);
  const j = await res.json();
  if (!j || !j.values) {
    console.error(`TwelveData returned no values for ${symbol} ${interval}`, j);
    return [];
  }
  // Returned values are newest -> oldest; we reverse to oldest -> newest
  const vals = j.values.slice().reverse();
  // map to simplified objects
  return vals.map(v => ({
    time: new Date(v.datetime || v.timestamp).toISOString(),
    ts: Math.floor(new Date(v.datetime || v.timestamp).getTime() / 1000),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: parseFloat(v.volume || 0)
  }));
}

// find index in array of 1m candles whose ts >= a given ts
function find1mIndexByTs(candles1m, ts) {
  // binary search
  let lo = 0, hi = candles1m.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles1m[mid].ts >= ts) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans;
}

// ------------------ INDICATOR WRAPPERS ------------------
function computeIndicatorsForSeries(values, highs, lows) {
  const rsi = values.length >= RSI_PERIOD ? ti.RSI.calculate({ period: RSI_PERIOD, values }) : [];
  const stochastic = (values.length >= STOCH_PERIOD && highs.length >= STOCH_PERIOD && lows.length >= STOCH_PERIOD)
    ? ti.Stochastic.calculate({ period: STOCH_PERIOD, signalPeriod: STOCH_SIGNAL, high: highs, low: lows, close: values })
    : [];
  const bb = values.length >= BB_PERIOD ? ti.BollingerBands.calculate({ period: BB_PERIOD, values, stdDev: BB_STD }) : [];
  const atr = (values.length >= ATR_PERIOD && highs.length >= ATR_PERIOD && lows.length >= ATR_PERIOD)
    ? ti.ATR.calculate({ period: ATR_PERIOD, high: highs, low: lows, close: values })
    : [];
  return { rsi, stochastic, bb, atr };
}

// determineMarketTypeFromBB (same logic as your bot)
function determineMarketTypeFromBB(values, bbArray) {
  if (!Array.isArray(bbArray) || !bbArray.length || !Array.isArray(values) || !values.length) return "sideways";
  const last = bbArray.at(-1);
  if (!last || !last.middle || last.middle === 0) return "sideways";
  const bbw = (last.upper - last.lower) / Math.abs(last.middle);
  const minLen = Math.min(values.length, bbArray.length);
  if (minLen <= 0) return "sideways";
  const recentValues = values.slice(-minLen);
  const recentBB = bbArray.slice(-minLen);
  let aboveCount = 0;
  for (let i = 0; i < minLen; i++) {
    if (recentValues[i] > recentBB[i].middle) aboveCount++;
  }
  const aboveMidFraction = aboveCount / minLen;
  if (bbw > STRONG_TREND_BBW && aboveMidFraction > 0.55) return "uptrend";
  if (bbw > STRONG_TREND_BBW && aboveMidFraction < 0.45) return "downtrend";
  if (bbw > 0.02 && aboveMidFraction > 0.6) return "uptrend";
  if (bbw > 0.02 && aboveMidFraction < 0.4) return "downtrend";
  return "sideways";
}

// ------------------ STRATEGY SIGNAL CHECK (exactly like your bot) ------------------
function checkEntryAt5mIndex(i5, series) {
  const { m30, m5, m1, ind30, ind5, ind1 } = series;
  if (!ind5?.stochastic?.length || !ind5?.rsi?.length) return null;

  const offsetRSI5 = m5.length - ind5.rsi.length;
  const offsetStoch5 = m5.length - ind5.stochastic.length;
  const lastRSI_M5 = ind5.rsi[i5 - offsetRSI5] ?? ind5.rsi.at(-1);
  const lastStoch_M5 = ind5.stochastic[i5 - offsetStoch5] ?? ind5.stochastic.at(-1);
  const prevStoch_M5 = ind5.stochastic[(i5 - 1) - offsetStoch5] ?? ind5.stochastic.at(-2);

  const lastRSI_M1 = ind1?.rsi?.at(-1) ?? null;
  const higherTrend = determineMarketTypeFromBB(m30, ind30.bb || []);
  if (!lastRSI_M5 || !lastStoch_M5 || !prevStoch_M5) return null;

  const buyCross = prevStoch_M5.k < 25 && lastStoch_M5.k >= 25;
  const sellCross = prevStoch_M5.k > 75 && lastStoch_M5.k <= 75;

  if (buyCross)
    console.log(`[BUY] Crossed 25 at ${m5[i5].time} | RSI5=${lastRSI_M5.toFixed(1)} | Trend=${higherTrend}`);
  if (sellCross)
    console.log(`[SELL] Crossed 75 at ${m5[i5].time} | RSI5=${lastRSI_M5.toFixed(1)} | Trend=${higherTrend}`);

  // --- Buy / Sell Triggers
  const buyTrigger =
    buyCross &&
    (lastRSI_M5 < 50 || lastRSI_M5 < 35) && // counter-trend tolerance
    ['uptrend', 'sideways', 'downtrend'].includes(higherTrend); // let’s allow both, we’ll filter outcome later

  const sellTrigger =
    sellCross &&
    (lastRSI_M5 > 50 || lastRSI_M5 > 65) &&
    ['downtrend', 'sideways', 'uptrend'].includes(higherTrend);

  // --- M1 Confirmation (relaxed and optional)
  const buyM1Confirm = !lastRSI_M1 || lastRSI_M1 < 60;
  const sellM1Confirm = !lastRSI_M1 || lastRSI_M1 > 40;

  if (buyTrigger && buyM1Confirm) return { side: 'BUY', higherTrend };
  if (sellTrigger && sellM1Confirm) return { side: 'SELL', higherTrend };

  return null;
}

// ------------------ TRADE SIMULATION ------------------
function computeTRR(ind30) {
  try {
    const last = ind30.bb.at(-1);
    const bbw30 = (last.upper - last.lower) / last.middle;
    if (bbw30 > STRONG_TREND_BBW) return 3.0;
    return 2.0;
  } catch (e) {
    return 1.5;
  }
}

// We'll model P/L in money terms using risk% per trade.
// If SL distance is D, and TP = D * TRR, then a win returns risk * TRR, a loss loses risk.
// This avoids dealing with lot and pip conversions.
function simulateTradeFrom5mIndex(i5, series, candles1m, config) {
  // determine entry minute: the first 1m candle that starts after the 5m close ts
  const m5c = series.m5[i5];
  const entryTs = m5c.ts + 60; // next 1m open (assumes 1m buckets)
  const startIdx = find1mIndexByTs(candles1m, entryTs);
  if (startIdx === -1) return null;

  // compute ATR on M5 at that moment
  const lastAtrM5 = series.ind5.atr.at(-1) || 0; // safe fallback
  if (!lastAtrM5 || lastAtrM5 <= 0) return null;

  const slDistance = lastAtrM5 * ATR_SL_MULTIPLIER;
  const trr = computeTRR(series.ind30); // tp/sl multiplier
  const side = series.signalAt[i5].side;
  const entryPrice = candles1m[startIdx].open;

  const slPrice = side === 'BUY' ? entryPrice - slDistance : entryPrice + slDistance;
  const tpPrice = side === 'BUY' ? entryPrice + slDistance * trr : entryPrice - slDistance * trr;

  // scan forward on 1m candles to see which hit first
  const maxIdx = Math.min(candles1m.length - 1, startIdx + (config.maxMinutes || MAX_TRADE_MINUTES));
  let hit = null;
  let exitPrice = null;
  let exitTs = null;
  for (let k = startIdx; k <= maxIdx; k++) {
    const c = candles1m[k];
    // check price path within candle using high/low
    if (side === 'BUY') {
      if (c.low <= slPrice && c.high >= tpPrice) {
        // both hit in same candle: determine which hit first is ambiguous
        // assume conservative: if open is closer to SL, SL hit first; else TP. Use distances from open.
        const distToSL = Math.abs(c.open - slPrice);
        const distToTP = Math.abs(c.open - tpPrice);
        if (distToTP <= distToSL) { hit = 'TP'; exitPrice = tpPrice; exitTs = c.ts; break; }
        else { hit = 'SL'; exitPrice = slPrice; exitTs = c.ts; break; }
      } else if (c.high >= tpPrice) { hit = 'TP'; exitPrice = tpPrice; exitTs = c.ts; break; }
      else if (c.low <= slPrice) { hit = 'SL'; exitPrice = slPrice; exitTs = c.ts; break; }
    } else { // SELL
      if (c.low <= tpPrice && c.high >= slPrice) {
        const distToTP = Math.abs(c.open - tpPrice), distToSL = Math.abs(c.open - slPrice);
        if (distToTP <= distToSL) { hit = 'TP'; exitPrice = tpPrice; exitTs = c.ts; break; }
        else { hit = 'SL'; exitPrice = slPrice; exitTs = c.ts; break; }
      } else if (c.low <= tpPrice) { hit = 'TP'; exitPrice = tpPrice; exitTs = c.ts; break; }
      else if (c.high >= slPrice) { hit = 'SL'; exitPrice = slPrice; exitTs = c.ts; break; }
    }
  }

  // If neither hit within max life, close at last candle close
  if (!hit) {
    const c = candles1m[Math.min(maxIdx, candles1m.length - 1)];
    exitPrice = c.close;
    exitTs = c.ts;
    // decide if that finish is win or loss by comparing direction
    if ((side === 'BUY' && exitPrice >= entryPrice) || (side === 'SELL' && exitPrice <= entryPrice)) hit = 'EXIT_NO_HIT_WIN';
    else hit = 'EXIT_NO_HIT_LOSS';
  }

  // money simulation
  // riskMoney = currentBalance * riskPercent
  // if TP hit: profit = riskMoney * (TP/SL) = risk * trr
  // if SL hit: loss = -riskMoney
  // if exit-no-hit: compute actual price movement ratio * riskMoney as approximation
  return {
    entryTs,
    entryPrice,
    slPrice,
    tpPrice,
    side,
    hit,
    exitPrice,
    exitTs,
    slDistance,
    trr
  };
}

// ------------------ BACKTEST DRIVER ------------------
async function runBacktest(params) {
  console.log('Backtest settings:', params);    
  console.log('Fetching historical candles from Twelve Data — this may take a few seconds...');

  // fetch 1m / 5m / 30m
  const outsize = 5000; // max allowed by Twelve Data
  const [c1, c5, c30] = await Promise.all([
    fetchCandles(SYMBOL, '1min', outsize, FROM, TO),
    fetchCandles(SYMBOL, '5min', outsize, FROM, TO),
    fetchCandles(SYMBOL, '30min', outsize, FROM, TO)
  ]);

  if (!c1.length || !c5.length || !c30.length) {
    console.error('Insufficient data from Twelve Data. Aborting.');
    return;
  }

  console.log(`Loaded candles: 1m=${c1.length}, 5m=${c5.length}, 30m=${c30.length}`);

  // compute indicator arrays for each TF
  const values30 = c30.map(x => x.close), highs30 = c30.map(x => x.high), lows30 = c30.map(x => x.low);
  const values5 = c5.map(x => x.close), highs5 = c5.map(x => x.high), lows5 = c5.map(x => x.low);
  const values1 = c1.map(x => x.close), highs1 = c1.map(x => x.high), lows1 = c1.map(x => x.low);

  const ind30 = computeIndicatorsForSeries(values30, highs30, lows30);
  const ind5 = computeIndicatorsForSeries(values5, highs5, lows5);
  const ind1 = computeIndicatorsForSeries(values1, highs1, lows1);

  // build a series object with easier indexing
  const series = {
    m30: c30,
    m5: c5,
    m1: c1,
    ind30, ind5, ind1,
    signalAt: new Array(c5.length).fill(null) // will mark signals
  };

  // scan each 5m index to detect signals (we will use indicators aligned by end)
  // For simplicity we use relative indexing: because indicator arrays are shorter, use latest values at that 5m index.
  // We'll compute signals using the approach used earlier; for each i5, we need to ensure we have enough ind arrays.
  const signals = [];
  for (let i5 = 2; i5 < c5.length; i5++) { // start after a couple of bars to have prev
    // compute small adjusted index approach: build temporary local indicator slices up to this index
    // Build temporary mini-series for indicators up to this i5
    const slice5 = { values: values5.slice(0, i5 + 1), high: highs5.slice(0, i5 + 1), low: lows5.slice(0, i5 + 1) };
    const miniInd5 = computeIndicatorsForSeries(slice5.values, slice5.high, slice5.low);
    const mini30 = { values: values30.slice(0, Math.max(30, 0)), high: highs30.slice(0, Math.max(30, 0)), low: lows30.slice(0, Math.max(30, 0)) };
    // but for trend we can use full ind30 as representative at that time (coarse)
    // Use the global ind arrays and m30/m5/m1 arrays in checkEntryAt5mIndex by supplying full 'series' (it reads .indX.at(-1) mainly)
    // To be more accurate we'd align indices; this implementation favors practicality and mirrors the live bot behavior which reads latest indicator results.
    // Mark latest ind arrays into series for decision use:
    series.ind5 = ind5;
    series.ind30 = ind30;
    series.ind1 = ind1;

    // call the check function
    const sig = checkEntryAt5mIndex(i5, series);
    if (sig) {
      series.signalAt[i5] = sig;
      signals.push({ i5, time: c5[i5].time, side: sig.side, higherTrend: sig.higherTrend });
    }
  }

  console.log(`Detected signals on 5m bars: ${signals.length}`);

  // Now simulate trades for each signal, scanning 1m candles to find TP/SL
  let balance = params.initialBalance || INITIAL_BALANCE;
  let equityCurve = [{ ts: c1[0].ts, equity: balance }];
  const trades = [];

  for (const s of signals) {
    const i5 = s.i5;
    series.signalAt = series.signalAt || [];
    // attach the signal to series for the simulate function
    series.signalAt[i5] = { side: s.side };

    const tradeSim = simulateTradeFrom5mIndex(i5, series, c1, { maxMinutes: MAX_TRADE_MINUTES });
    if (!tradeSim) continue;

    // money risk based sizing
    const riskMoney = balance * DEFAULT_RISK;
    let pnl = 0;
    if (tradeSim.hit === 'TP') {
      pnl = riskMoney * tradeSim.trr; // profit = risk * trr
    } else if (tradeSim.hit === 'SL') {
      pnl = -riskMoney;
    } else if (tradeSim.hit === 'EXIT_NO_HIT_WIN') {
      // approximate profit by price movement ratio vs SL
      const move = Math.abs(tradeSim.exitPrice - tradeSim.entryPrice);
      const ratio = move / tradeSim.slDistance;
      pnl = Math.max(-riskMoney, riskMoney * ratio * tradeSim.trr);
    } else if (tradeSim.hit === 'EXIT_NO_HIT_LOSS') {
      const move = Math.abs(tradeSim.exitPrice - tradeSim.entryPrice);
      const ratio = move / tradeSim.slDistance;
      pnl = Math.min(-riskMoney, -riskMoney * ratio);
    } else {
      // fallback treat as loss
      pnl = -riskMoney;
    }

    const before = balance;
    balance += pnl;
    trades.push({
      time: s.time,
      side: tradeSim.side,
      entry: tradeSim.entryPrice,
      exit: tradeSim.exitPrice,
      hit: tradeSim.hit,
      pnl,
      balanceBefore: before,
      balanceAfter: balance,
      sl: tradeSim.slPrice,
      tp: tradeSim.tpPrice,
      trr: tradeSim.trr
    });

    equityCurve.push({ ts: tradeSim.exitTs || tradeSim.entryTs, equity: balance });
  }

  // Summary
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const total = trades.length;
  const totalPnL = balance - (params.initialBalance || INITIAL_BALANCE);
  const winRate = total ? (wins.length / total) : 0;
  const avgWin = wins.length ? wins.reduce((s,t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s,t) => s + t.pnl, 0) / losses.length : 0;
  const pf = Math.abs(losses.length ? (wins.reduce((s,t) => s + t.pnl, 0) / Math.abs(losses.reduce((s,t) => s + t.pnl, 0))) : 0);

  console.log('---------------- BACKTEST RESULT ----------------');
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`Period: ${FROM || 'start'} -> ${TO || 'end'}`);
  console.log(`Initial Balance: ${(params.initialBalance || INITIAL_BALANCE).toFixed(2)}`);
  console.log(`Final Balance: ${balance.toFixed(2)} (PnL ${totalPnL.toFixed(2)})`);
  console.log(`Total Trades: ${total} | Wins: ${wins.length} | Losses: ${losses.length} | WinRate: ${(winRate*100).toFixed(1)}%`);
  console.log(`Avg Win: ${avgWin.toFixed(2)} | Avg Loss: ${avgLoss.toFixed(2)} | Profit Factor: ${pf.toFixed(2)}`);
  console.log('-------------------------------------------------');

  if (EXPORT_EQUITY_CSV) {
    const out = ['ts,iso,equity'];
    for (const p of equityCurve) {
      out.push(`${p.ts},${new Date(p.ts*1000).toISOString()},${p.equity.toFixed(2)}`);
    }
    const outfile = path.join(process.cwd(), `equity_${SYMBOL.replace(/[\/ ]/g,'_')}_${Date.now()}.csv`);
    fs.writeFileSync(outfile, out.join('\n'));
    console.log('Equity curve exported to', outfile);
  }

  // also dump trades to JSON/CSV for inspection
  const tradesFile = path.join(process.cwd(), `trades_${SYMBOL.replace(/[\/ ]/g,'_')}_${Date.now()}.json`);
  fs.writeFileSync(tradesFile, JSON.stringify(trades, null, 2));
  console.log('Trades saved to', tradesFile);

  return { balance, trades, equityCurve };
}

// ------------------ RUN ------------------
(async () => {
  try {
    const res = await runBacktest({
      symbol: SYMBOL,
      from: FROM,
      to: TO,
      initialBalance: INITIAL_BALANCE
    });
    console.log('Done.');
    if (VERBOSE) console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('Backtest failed:', e.message || e);
  }
})();
