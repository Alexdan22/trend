// main.js — Efficient Aggregation Version + Historical Preload
// Combines: MetaApi connection, strategy logic, efficient candle aggregation, and Telegram alerts.

require('dotenv').config();
const MetaApi = require('metaapi.cloud-sdk').default;
const MetaStats = require('metaapi.cloud-metastats-sdk').default;
const ti = require('technicalindicators');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const TelegramBot = require('node-telegram-bot-api');

// --------------------- CONFIG ---------------------
const METAAPI_TOKEN = process.env.METAAPI_TOKEN || "REPLACE_WITH_TOKEN";
const ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID || "REPLACE_WITH_ACCOUNT_ID";
const SYMBOL = process.env.SYMBOL || "XAUUSDm";
const MAX_OPEN_TRADES = 3;
const MAX_TOTAL_RISK = 0.06;
const DEFAULT_RISK_PER_NEW_TRADE = 0.02;
const MIN_LOT = 0.01;
const LOT_ROUND = 2;
const ATR_PERIOD = 14;
const ATR_SL_MULTIPLIER = 1.2;
const STRONG_TREND_BBW = 0.035;
const CHECK_INTERVAL_MS = 10_000;
const COOLDOWN_MINUTES = 10;

// --------------------- TELEGRAM ---------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let tgBot = null;
if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
  tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
  console.log('📲 Telegram bot connected.');
}
async function sendTelegram(msg, opts = {}) {
  if (!tgBot || !TELEGRAM_CHAT_ID) return;
  try { await tgBot.sendMessage(TELEGRAM_CHAT_ID, msg, opts); }
  catch (e) { console.warn('Telegram send failed:', e.message); }
}

// --------------------- GLOBAL STATE ---------------------
let api, account, connection, metastatsApi;
let accountBalance = 0;
let closesM30 = [], highsM30 = [], lowsM30 = [];
let closesM5 = [], highsM5 = [], lowsM5 = [];
let closesM1 = [], highsM1 = [], lowsM1 = [];
let lastSignal = null;
let openTradeRecords = {};

// --------------------- AGGREGATOR ---------------------
class EfficientAggregator {
  constructor(symbol) {
    this.symbol = symbol;
    this.candles = { '1m': [], '5m': [], '30m': [] };
    this.current = { '1m': null, '5m': null, '30m': null };
  }

  _tfSec(tf) {
    if (tf === '1m') return 60;
    if (tf === '5m') return 300;
    if (tf === '30m') return 1800;
  }
  _tfStart(ts, tfSec) { return Math.floor(ts / tfSec) * tfSec; }

  update(tick) {
    const now = tick.timestamp ? tick.timestamp : Math.floor(Date.now() / 1000);
    const price = (tick.bid + tick.ask) / 2;
    for (const tf of ['1m', '5m', '30m']) {
      const tfSec = this._tfSec(tf);
      const start = this._tfStart(now, tfSec);
      let c = this.current[tf];
      if (!c || c.timestamp !== start) {
        if (c) this.candles[tf].push({ ...c, closed: true });
        this.current[tf] = { timestamp: start, open: price, high: price, low: price, close: price, volume: 0 };
        c = this.current[tf];
      }
      if (price > c.high) c.high = price;
      if (price < c.low) c.low = price;
      c.close = price;
      c.volume += 1;
    }
  }

  getLastClosed(tf) {
    const arr = this.candles[tf];
    if (!arr.length) return null;
    return arr[arr.length - 1];
  }
}

// --------------------- HISTORICAL PRELOAD ---------------------
async function preloadHistoricalCandlesFromTwelveData(symbol = 'XAU/USD') {
  console.log(`[INIT] Fetching historical candles for ${symbol} from Twelve Data...`);
  const API_KEY = process.env.TWELVE_DATA_KEY;
  if (!API_KEY) {
    console.warn('[INIT] No Twelve Data API key found. Skipping preload.');
    return;
  }

  const tfMap = { '1m': '1min', '5m': '5min', '30m': '30min' };
  for (const [tf, interval] of Object.entries(tfMap)) {
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=200&apikey=${API_KEY}`;
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

        console.log(`[PRELOAD] ${tf} loaded: ${candles.length} candles`);
      } else {
        console.warn(`[PRELOAD] No ${tf} candles returned from Twelve Data`);
      }
    } catch (e) {
      console.warn(`[PRELOAD] Failed for ${tf}: ${e.message}`);
    }
  }
  console.log('[PRELOAD] Historical preload complete.');
}

// --------------------- INDICATORS (fixed checks) ---------------------
function calculateIndicators(values, highs, lows) {
  const enough = (a, n) => Array.isArray(a) && a.length >= n;
  // RSI period 14 needs at least 14 values
  const rsi = enough(values, 14) ? ti.RSI.calculate({ period: 14, values }) : [];
  // Stochastic with period 14 needs at least 14 highs/lows/values
  const stochastic = (enough(values, 14) && enough(highs, 14) && enough(lows, 14))
    ? ti.Stochastic.calculate({ period: 14, signalPeriod: 3, high: highs, low: lows, close: values })
    : [];
  // Bollinger Bands period 20 needs at least 20 values
  const bb = enough(values, 20) ? ti.BollingerBands.calculate({ period: 20, values, stdDev: 2 }) : [];
  // ATR period uses ATR_PERIOD (14), needs at least ATR_PERIOD values (technicalindicators often needs period+1, keep a small margin)
  const atr = (enough(values, ATR_PERIOD) && enough(highs, ATR_PERIOD) && enough(lows, ATR_PERIOD))
    ? ti.ATR.calculate({ period: ATR_PERIOD, high: highs, low: lows, close: values })
    : [];
  return { rsi, stochastic, bb, atr };
}

// --------------------- MARKET TYPE (fixed alignment & safety) ---------------------
function determineMarketTypeFromBB(values, bbArray) {
  if (!Array.isArray(bbArray) || !bbArray.length || !Array.isArray(values) || !values.length) return "sideways";

  const last = bbArray.at(-1);
  if (!last || !last.middle || last.middle === 0) return "sideways";

  // compute BB width safely
  const bbw = (last.upper - last.lower) / Math.abs(last.middle);

  // align lengths — compare last N candles where we have both value and bb
  const minLen = Math.min(values.length, bbArray.length);
  if (minLen <= 0) return "sideways";

  const recentValues = values.slice(-minLen);
  const recentBB = bbArray.slice(-minLen);

  let aboveCount = 0;
  for (let i = 0; i < minLen; i++) {
    if (recentValues[i] > recentBB[i].middle) aboveCount++;
  }
  const aboveMidFraction = aboveCount / minLen;

  // debug threshold behavior (small console.debug so you can enable/scan)
  console.debug(`[BB] minLen=${minLen} bbw=${(bbw).toFixed(4)} aboveFrac=${aboveMidFraction.toFixed(3)}`);

  // thresholds (you can tune these)
  if (bbw > STRONG_TREND_BBW && aboveMidFraction > 0.6) return "uptrend";
  if (bbw > STRONG_TREND_BBW && aboveMidFraction < 0.4) return "downtrend";
  if (bbw > 0.02 && aboveMidFraction > 0.6) return "uptrend";
  if (bbw > 0.02 && aboveMidFraction < 0.4) return "downtrend";
  return "sideways";
}


// --------------------- STRATEGY CORE ---------------------
async function checkStrategy(m5CandleTime = null) {
  const ind30 = calculateIndicators(closesM30, highsM30, lowsM30);
  const ind5 = calculateIndicators(closesM5, highsM5, lowsM5);
  const ind1 = calculateIndicators(closesM1, highsM1, lowsM1);

  // debug: print lengths so you can spot missing data
  console.log(`[DBG] lens -> M30 closes:${closesM30.length} bb:${ind30.bb.length} rsi:${ind30.rsi.length}`);
  console.log(`[DBG] lens -> M5 closes:${closesM5.length} bb:${ind5.bb.length} rsi:${ind5.rsi.length}`);
  console.log(`[DBG] lens -> M1 closes:${closesM1.length} bb:${ind1.bb.length} rsi:${ind1.rsi.length}`);

  const higherTrend = determineMarketTypeFromBB(closesM30, ind30.bb);

  const lastRSI_M5 = ind5.rsi.at(-1);
  const lastStoch_M5 = ind5.stochastic.at(-1);
  const prevStoch_M5 = ind5.stochastic.at(-2);
  const lastRSI_M1 = ind1.rsi.at(-1);
  const lastStoch_M1 = ind1.stochastic.at(-1);

  // debug the key numbers used by the strategy
  console.log(`[DBG] M30 -> lastBB_middle:${ind30.bb.at(-1)?.middle ?? 'n/a'} lastBB_up:${ind30.bb.at(-1)?.upper ?? 'n/a'}`);
  if (!lastRSI_M5 || !lastRSI_M1 || !lastStoch_M5 || !lastStoch_M1 || !prevStoch_M5) {
    console.log('[STRAT] Not enough indicator data yet — skipping strategy run.');
    return;
  }

  console.log(`[STRAT] M30:${higherTrend} | M5 RSI:${lastRSI_M5.toFixed(2)} Stoch:${lastStoch_M5.k?.toFixed(2)} | M1 RSI:${lastRSI_M1.toFixed(2)} Stoch:${lastStoch_M1.k?.toFixed(2)}`);
}


// --------------------- CANDLE HANDLER ---------------------
function pushAndTrim(arr, v, max = 400) { arr.push(v); if (arr.length > max) arr.shift(); }

function onCandle(candle) {
  const { timeframe: tf, high, low, close } = candle;

  // Store candle data
  if (tf === '30m') { pushAndTrim(closesM30, close); pushAndTrim(highsM30, high); pushAndTrim(lowsM30, low); }
  if (tf === '5m') { pushAndTrim(closesM5, close); pushAndTrim(highsM5, high); pushAndTrim(lowsM5, low); }
  if (tf === '1m') { pushAndTrim(closesM1, close); pushAndTrim(highsM1, high); pushAndTrim(lowsM1, low); }

  // 🧩 NEW: Log latest 5 candles for each timeframe
  if (tf === '1m' || tf === '5m' || tf === '30m') {
    const slice = (arr) => arr.slice(-5).map(v => v.toFixed(2));
    console.log(`\n🕒 [${tf}] Latest 5 Close Prices: ${slice(
      tf === '1m' ? closesM1 :
      tf === '5m' ? closesM5 :
      closesM30
    ).join(', ')}`);

    console.log(`Highs: ${slice(
      tf === '1m' ? highsM1 :
      tf === '5m' ? highsM5 :
      highsM30
    ).join(', ')}`);

    console.log(`Lows: ${slice(
      tf === '1m' ? lowsM1 :
      tf === '5m' ? lowsM5 :
      lowsM30
    ).join(', ')}\n`);
  }

  // relaxed guard after preload
  if (tf === '5m' && closesM30.length >= 14 && closesM5.length >= 14 && closesM1.length >= 14) {
    checkStrategy(candle.time).catch(err => console.error('checkStrategy error:', err));
  }
}


// --------------------- MAIN LOOP ---------------------
(async () => {
  try {
    api = new MetaApi(METAAPI_TOKEN);
    metastatsApi = new MetaStats(METAAPI_TOKEN);
    account = await api.metatraderAccountApi.getAccount(ACCOUNT_ID);

    if (account.state !== 'DEPLOYED') {
      console.log('Deploying account...');
      await account.deploy();
      await account.waitConnected();
    }

    connection = account.getStreamingConnection();
    await connection.connect();
    if (connection.waitSynchronized) {
      console.log('Waiting for MetaApi synchronization...');
      await connection.waitSynchronized();
    }

    // preload historical candles before subscribing
    await preloadHistoricalCandlesFromTwelveData('XAU/USD');

    const terminalState = connection.terminalState;
    accountBalance = terminalState.accountInformation?.balance || 0;
    console.log('Connected. Balance:', accountBalance);

    await sendTelegram(`✅ Bot connected\nSymbol: ${SYMBOL}\nBalance: ${accountBalance.toFixed(2)}`, { parse_mode: 'Markdown' });

    // retry loop for subscription
    let subscribed = false;
    for (let i = 0; i < 5 && !subscribed; i++) {
      try {
        console.log(`[INIT] Attempt ${i + 1}: subscribing to ${SYMBOL}...`);
        if (connection.subscribeToMarketData) {
          await connection.subscribeToMarketData(SYMBOL);
          subscribed = true;
          console.log(`[CANDLES] Subscribed to ${SYMBOL}`);
        }
      } catch (e) {
        console.warn(`Subscription attempt ${i + 1} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    if (!subscribed) throw new Error('Unable to subscribe to market data after 5 attempts');

    const candleAgg = new EfficientAggregator(SYMBOL);
    let lastClosed = { '1m': 0, '5m': 0, '30m': 0 };

    const pollTicks = async () => {
      try {
        const price = connection.terminalState?.price(SYMBOL);
        if (price?.bid != null && price?.ask != null) {
          candleAgg.update(price);
          for (const tf of ['1m', '5m', '30m']) {
            const closed = candleAgg.getLastClosed(tf);
            if (closed && closed.timestamp !== lastClosed[tf]) {
              lastClosed[tf] = closed.timestamp;
              onCandle({
                symbol: SYMBOL,
                timeframe: tf,
                ...closed,
                time: new Date(closed.timestamp * 1000).toISOString(),
              });
            }
          }
        }
      } catch (e) {
        console.warn('pollTicks error:', e.message);
      }
    };

    setInterval(pollTicks, 2000);
    console.log('Bot running. Listening to aggregated candles for', SYMBOL);
  } catch (e) {
    console.error('Fatal:', e.message);
  }
})();
