// bot.js
// Single-file Node.js trading bot (MetaApi + Exness MT5) with indicators, risk sizing, Telegram alerts, and CSV logging.
// Requires: metaapi.cloud-sdk, technicalindicators, node-telegram-bot-api
// Run with Node >= 16 and package.json "type": "module"

// --------------------------- CONFIG ---------------------------
import fs from 'fs';
import path from 'path';
import MetaApi from 'metaapi.cloud-sdk';
import { RSI, Stochastic, BollingerBands } from 'technicalindicators';
import TelegramBot from 'node-telegram-bot-api';

const CONFIG = {
  METAAPI_TOKEN: 'YOUR_METAAPI_TOKEN',
  MT_LOGIN: 'YOUR_MT5_LOGIN',         // Exness MT5 login (demo for testing)
  MT_PASSWORD: 'YOUR_MT5_PASSWORD',
  MT_SERVER: 'YOUR_MT5_SERVER',       // e.g., 'Exness-MT5Trial' (check mt5 terminal)
  SYMBOL: 'XAUUSD',                   // trading symbol
  TIMEFRAME: '5m',                    // timeframe for signals
  CHECK_INTERVAL_MS: 60 * 1000,       // strategy polling interval (ms)

  // Risk & trade sizing
  RISK_PER_TRADE_PERCENT: 1,          // percent of balance to risk per trade
  STOP_LOSS_PIPS: 200,                // SL in pips (adjust for symbol)
  TAKE_PROFIT_PIPS: 400,              // TP in pips
  MIN_LOT: 0.01,                      // broker minimum lot
  MAX_LOT: 10,                        // safety cap
  PIP_VALUE_PER_LOT_USD: 1.0,         // approximate pip value per 1 lot -- broker dependent, adjust accordingly

  // Telegram
  TELEGRAM_TOKEN: 'YOUR_TELEGRAM_BOT_TOKEN',
  TELEGRAM_CHAT_ID: 'YOUR_CHAT_ID',   // e.g., 123456789

  // Logging
  TRADE_LOG_CSV: path.resolve(process.cwd(), 'trades.csv'),

  // Strategy indicator settings
  RSI_PERIOD: 14,
  STOCH_PERIOD: 14,
  STOCH_SIGNAL: 3,
  BB_PERIOD: 20,
  BB_STDDEV: 2
};
// ------------------------- END CONFIG -------------------------

// --------------------------- HELPERS ---------------------------
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function appendTradeCsv(row) {
  const csvLine = [
    row.timestamp,
    row.symbol,
    row.direction,
    row.lots,
    row.entry,
    row.sl,
    row.tp,
    row.balance,
    row.ticket || ''
  ].join(',') + '\n';

  // If file doesn't exist, write header first
  if (!fs.existsSync(CONFIG.TRADE_LOG_CSV)) {
    const header = 'timestamp,symbol,direction,lots,entry,sl,tp,balance,ticket\n';
    fs.appendFileSync(CONFIG.TRADE_LOG_CSV, header, 'utf8');
  }
  fs.appendFileSync(CONFIG.TRADE_LOG_CSV, csvLine, 'utf8');
}

// Convert pips to price units (assumes pip unit is 0.01 for XAUUSD example).
// NOTE: pip definition varies across brokers. Adjust factor accordingly.
function pipsToPrice(pips) {
  // We'll treat 1 pip = 0.1 for XAUUSD as used earlier (user may adjust)
  // More generally: priceMove = pips * pipMultiplier
  const pipMultiplier = 0.1;
  return pips * pipMultiplier;
}

// Estimate lots required to risk X% of balance given SL pips and pip value per lot.
// This is a conservative simple calculation; adjust pip value per lot to match your broker's instrument spec.
function calculateLots(balance, riskPercent, stopLossPips) {
  const riskUsd = (balance * riskPercent) / 100;
  // loss per 1 lot = stopLossPips * PIP_VALUE_PER_LOT_USD
  const lossPerLot = stopLossPips * CONFIG.PIP_VALUE_PER_LOT_USD;
  if (lossPerLot <= 0) return CONFIG.MIN_LOT;
  let lots = riskUsd / lossPerLot;
  // Round to 2 decimals typical, enforce min/max
  lots = Math.max(CONFIG.MIN_LOT, Math.min(CONFIG.MAX_LOT, +lots.toFixed(2)));
  return lots;
}

// Safe wrapper to sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ------------------------ TELEGRAM SETUP ------------------------
const telegramBot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });
async function tgSend(msg) {
  try {
    await telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, msg);
  } catch (err) {
    log('Telegram send error:', err.message || err);
  }
}

// ------------------------ METAAPI & STRATEGY ------------------------
const api = new MetaApi(CONFIG.METAAPI_TOKEN);

// Find or create account in MetaApi
async function getOrCreateAccount() {
  const accounts = await api.metatraderAccountApi.getAccounts();
  let account = accounts.find(a => String(a.login) === String(CONFIG.MT_LOGIN));
  if (!account) {
    log('Account not found in MetaApi, creating...');
    account = await api.metatraderAccountApi.createAccount({
      name: `exness-mt5-${CONFIG.MT_LOGIN}`,
      type: 'cloud',
      login: CONFIG.MT_LOGIN,
      password: CONFIG.MT_PASSWORD,
      server: CONFIG.MT_SERVER,
      platform: 'mt5'
    });
    log('Created account. Deploying (this may take a minute)...');
    await account.deploy();
  } else {
    log('Found existing MetaApi account for login', CONFIG.MT_LOGIN);
  }
  // Wait until connected
  await account.waitConnected();
  log('MetaApi account is connected & deployed.');
  return account;
}

async function computeIndicatorsFromCandles(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const rsiValues = RSI.calculate({ period: CONFIG.RSI_PERIOD, values: closes });
  const stochValues = Stochastic.calculate({
    high: highs, low: lows, close: closes,
    period: CONFIG.STOCH_PERIOD, signalPeriod: CONFIG.STOCH_SIGNAL
  });
  const bbValues = BollingerBands.calculate({
    period: CONFIG.BB_PERIOD,
    values: closes,
    stdDev: CONFIG.BB_STDDEV
  });

  return {
    rsi: rsiValues.length ? rsiValues[rsiValues.length - 1] : null,
    stoch: stochValues.length ? stochValues[stochValues.length - 1] : null,
    bb: bbValues.length ? bbValues[bbValues.length - 1] : null,
    lastClose: closes.length ? closes[closes.length - 1] : null
  };
}

// Check if there is any existing open position for SYMBOL
async function hasOpenPosition(connection, symbol) {
  try {
    const positions = await connection.getPositions();
    if (!positions) return false;
    return positions.some(p => p.symbol === symbol && (p.type === 'LONG' || p.type === 'SHORT' || p.action === 'open'));
  } catch (err) {
    log('Error fetching positions:', err.message || err);
    return false; // be conservative: allow trading if we can't confirm? we return false; caller may want to be strict
  }
}

// Main trade decision & execution
async function evaluateAndTrade(connection) {
  try {
    // fetch candles
    const candles = await connection.getCandles(CONFIG.SYMBOL, CONFIG.TIMEFRAME, 200);
    if (!candles || candles.length === 0) {
      log('No candles returned.');
      return;
    }

    const ind = await computeIndicatorsFromCandles(candles);
    if (!ind.rsi || !ind.stoch || !ind.bb) {
      log('Insufficient indicator data yet.');
      return;
    }

    log(`Indicators: RSI=${ind.rsi.toFixed(2)}, StochK=${ind.stoch.k.toFixed(2)}, StochD=${ind.stoch.d.toFixed(2)}, Close=${ind.lastClose}`);

    // check existing position
    const openExists = await hasOpenPosition(connection, CONFIG.SYMBOL);
    if (openExists) {
      log('Open position detected on symbol; skipping new entry.');
      return;
    }

    // entry rules
    let direction = null;
    if (ind.rsi < 40 && ind.stoch.k < 20 && ind.lastClose < ind.bb.lower) {
      direction = 'buy';
    } else if (ind.rsi > 60 && ind.stoch.k > 80 && ind.lastClose > ind.bb.upper) {
      direction = 'sell';
    } else {
      log('No entry signal.');
      return;
    }

    // account info & lot sizing
    const accountInfo = await connection.accountInformation;
    const balance = (accountInfo && accountInfo.balance) ? accountInfo.balance : null;
    if (balance === null) {
      log('Unable to read balance; aborting trade.');
      await tgSend(`⚠️ Bot error: unable to read account balance.`);
      return;
    }
    const lots = calculateLots(balance, CONFIG.RISK_PER_TRADE_PERCENT, CONFIG.STOP_LOSS_PIPS);

    // get price ticks
    const tick = await connection.getSymbolPrice(CONFIG.SYMBOL);
    const entryPrice = direction === 'buy' ? tick.ask : tick.bid;

    const sl = direction === 'buy'
      ? entryPrice - pipsToPrice(CONFIG.STOP_LOSS_PIPS)
      : entryPrice + pipsToPrice(CONFIG.STOP_LOSS_PIPS);

    const tp = direction === 'buy'
      ? entryPrice + pipsToPrice(CONFIG.TAKE_PROFIT_PIPS)
      : entryPrice - pipsToPrice(CONFIG.TAKE_PROFIT_PIPS);

    log(`Placing ${direction.toUpperCase()} order: lots=${lots}, entry=${entryPrice}, sl=${sl}, tp=${tp}`);

    // place order
    let result;
    if (direction === 'buy') {
      result = await connection.createMarketBuyOrder(CONFIG.SYMBOL, lots, { stopLoss: sl, takeProfit: tp, comment: 'node-bot' });
    } else {
      result = await connection.createMarketSellOrder(CONFIG.SYMBOL, lots, { stopLoss: sl, takeProfit: tp, comment: 'node-bot' });
    }

    log('Order result:', result);
    const ticket = (result && result.orderId) ? result.orderId : (result && result.deal) ? result.deal : '';

    // log & notify
    const msg = [
      `✅ ${direction.toUpperCase()} placed`,
      `Symbol: ${CONFIG.SYMBOL}`,
      `Lots: ${lots}`,
      `Entry: ${entryPrice}`,
      `SL: ${sl}`,
      `TP: ${tp}`,
      `Balance: ${balance}`,
      `Ticket: ${ticket}`
    ].join('\n');

    await tgSend(msg);
    await appendTradeCsv({
      timestamp: new Date().toISOString(),
      symbol: CONFIG.SYMBOL,
      direction,
      lots,
      entry: entryPrice,
      sl,
      tp,
      balance,
      ticket
    });

  } catch (err) {
    log('Error in evaluateAndTrade:', err.message || err);
    await tgSend(`❌ Bot error: ${err.message || err}`);
  }
}

// ------------------------ RUN LOOP & BOOT ------------------------
async function startBot() {
  log('Starting bot...');
  try {
    const account = await getOrCreateAccount();
    const connection = await account.connect();
    log('Connecting to account connection...');
    await connection.waitSynchronized();
    log('Connection synchronized. Bot entering main loop.');

    // Immediately run one evaluation, then interval
    await evaluateAndTrade(connection);
    setInterval(async () => {
      try {
        // if disconnected, try to reconnect
        if (!connection.isSynchronized()) {
          log('Connection not synchronized, attempting reconnect...');
          await connection.reconnect();
          await connection.waitSynchronized();
          log('Reconnected and synchronized.');
        }
        await evaluateAndTrade(connection);
      } catch (err) {
        log('Loop error:', err.message || err);
        await tgSend(`❗ Bot loop error: ${err.message || err}`);
      }
    }, CONFIG.CHECK_INTERVAL_MS);

  } catch (err) {
    log('Startup error:', err.message || err);
    await tgSend(`🔥 Bot failed to start: ${err.message || err}`);
    process.exit(1);
  }
}

// graceful shutdown
process.on('SIGINT', async () => {
  log('Shutting down (SIGINT).');
  await tgSend('🛑 Bot shutting down (SIGINT).');
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  log('Uncaught exception:', err);
  await tgSend(`💥 Uncaught exception: ${err.message || err}`);
  process.exit(1);
});

// start
startBot();
