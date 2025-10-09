// core/strategy.js
// Main trading strategy logic (entry detection and trade placement)

const { calculateIndicators, determineMarketTypeFromBB } = require('./indicators');
const { getPrice, getBalance } = require('./account');
const { safePlaceMarketOrder, safeGetPositions } = require('./orderHandler');
const {
  calculateLotFromRisk,
  computeAllowedRiskForNewTrade,
  canTakeTrade,
  safeLog
} = require('./utils');
const tradeManager = require('./tradeManager');

const ATR_SL_MULTIPLIER = parseFloat(process.env.ATR_SL_MULTIPLIER || '1.2');
const MAX_OPEN_TRADES = parseInt(process.env.MAX_OPEN_TRADES || '3', 10);
const DEFAULT_RISK_PER_TRADE = parseFloat(process.env.DEFAULT_RISK_PER_TRADE || '0.02');
const SYMBOL = process.env.SYMBOL || 'XAUUSDm';

let lastSignal = null;
let openTradeRecords = {};

async function checkStrategy(
  timeframeData,
  accountBalanceCache = 0
) {
  const { m30, m5, m1 } = timeframeData;
  if (!m30?.closes?.length || !m5?.closes?.length || !m1?.closes?.length) return;

  const ind30 = calculateIndicators(m30.closes, m30.highs, m30.lows);
  const ind5 = calculateIndicators(m5.closes, m5.highs, m5.lows);
  const ind1 = calculateIndicators(m1.closes, m1.highs, m1.lows);

  const higherTrend = determineMarketTypeFromBB(m30.closes, ind30.bb);
  const lastRSI_M5 = ind5.rsi.at(-1);
  const lastStoch_M5 = ind5.stochastic.at(-1);
  const prevStoch_M5 = ind5.stochastic.at(-2);
  const lastRSI_M1 = ind1.rsi.at(-1);
  const lastStoch_M1 = ind1.stochastic.at(-1);
  const lastATR_M5 = ind5.atr.at(-1) || 0;

  if (!lastStoch_M5 || !prevStoch_M5 || !lastStoch_M1) return;

  safeLog(`[STRAT] Trend:${higherTrend} | RSI5:${lastRSI_M5?.toFixed(2)} | Stoch5:${lastStoch_M5?.k?.toFixed(2)}`);

  const openPositions = await safeGetPositions();
  await tradeManager.syncOpenTradeRecordsWithPositions(openPositions);

  if (openPositions.length >= MAX_OPEN_TRADES) {
    await tradeManager.monitorOpenTrades(ind30, ind5, ind1);
    return;
  }

  const allowedRiskPercent = computeAllowedRiskForNewTrade(openTradeRecords);
  if (allowedRiskPercent <= 0) return;

  const buyM5Trigger = prevStoch_M5.k < 20 && lastStoch_M5.k >= 20 && lastRSI_M5 < 40;
  const buyM1Confirm = lastRSI_M1 < 40 && lastStoch_M1.k < 20;
  const sellM5Trigger = prevStoch_M5.k > 80 && lastStoch_M5.k <= 80 && lastRSI_M5 > 60;
  const sellM1Confirm = lastRSI_M1 > 60 && lastStoch_M1.k > 80;

  const slDistance = Math.max(lastATR_M5 * ATR_SL_MULTIPLIER, 2.0);
  const slPips = slDistance / 0.1;
  let accountBalance = accountBalanceCache || (await getBalance());
  const lot = calculateLotFromRisk(accountBalance, allowedRiskPercent, slPips, 1.0);
  const price = await getPrice(SYMBOL);
  if (!price) return;
  const { bid, ask } = price;

  // BUY
  if (higherTrend === 'uptrend' && buyM5Trigger && buyM1Confirm) {
    if (!canTakeTrade(lastSignal, 'BUY', m5.time)) return;
    const slPrice = ask - slDistance;
    const tpPrice = ask + slDistance * 2;
    const res = await safePlaceMarketOrder('BUY', lot, slPrice, tpPrice);
    await tradeManager.registerNewOpenTrade(res, 'BUY', lot, slPrice, tpPrice, allowedRiskPercent);
    lastSignal = { type: 'BUY', m5CandleTime: m5.time, time: new Date().toISOString() };
  }

  // SELL
  if (higherTrend === 'downtrend' && sellM5Trigger && sellM1Confirm) {
    if (!canTakeTrade(lastSignal, 'SELL', m5.time)) return;
    const slPrice = bid + slDistance;
    const tpPrice = bid - slDistance * 2;
    const res = await safePlaceMarketOrder('SELL', lot, slPrice, tpPrice);
    await tradeManager.registerNewOpenTrade(res, 'SELL', lot, slPrice, tpPrice, allowedRiskPercent);
    lastSignal = { type: 'SELL', m5CandleTime: m5.time, time: new Date().toISOString() };
  }

  await tradeManager.monitorOpenTrades(ind30, ind5, ind1);
}

module.exports = {
  checkStrategy,
  getOpenTradeRecords: () => openTradeRecords
};
