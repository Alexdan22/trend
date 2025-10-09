// core/utils.js
// Small utility helpers - CommonJS

const MIN_LOT = parseFloat(process.env.MIN_LOT || '0.01');
const LOT_ROUND = parseInt(process.env.LOT_DECIMALS || '2', 10);
const DEFAULT_MAX_TOTAL_RISK = parseFloat(process.env.MAX_TOTAL_RISK || '0.06'); // 6%
const DEFAULT_MAX_OPEN_TRADES = parseInt(process.env.MAX_OPEN_TRADES || '3', 10);
const DEFAULT_RISK_PER_TRADE = parseFloat(process.env.DEFAULT_RISK_PER_TRADE || '0.02'); // 2%
const COOLDOWN_MINUTES = parseFloat(process.env.COOLDOWN_MINUTES || '10');

/** Safe console logger (replaceable) */
function safeLog(...args) {
  try {
    console.log(...args);
  } catch (e) {}
}

/** Round lot to allowed decimals and enforce minimum */
function roundLot(lot) {
  if (!isFinite(lot) || lot <= 0) return MIN_LOT;
  const p = Math.pow(10, LOT_ROUND);
  return Math.max(MIN_LOT, Math.round(lot * p) / p);
}

/**
 * Compute allowed risk per new trade given current openRecords map (object with riskPercent field),
 * maxTotalRisk and maxOpenTrades.
 */
function computeAllowedRiskForNewTrade(openRecords = {}, {
  maxTotalRisk = DEFAULT_MAX_TOTAL_RISK,
  maxOpenTrades = DEFAULT_MAX_OPEN_TRADES,
  defaultRiskPerTrade = DEFAULT_RISK_PER_TRADE
} = {}) {
  const used = Object.values(openRecords).reduce((s, r) => s + (r.riskPercent || 0), 0);
  const remaining = Math.max(0, maxTotalRisk - used);
  const remainingSlots = Math.max(1, maxOpenTrades - Object.keys(openRecords).length);
  return Math.min(defaultRiskPerTrade, remaining / remainingSlots);
}

/**
 * Calculate lot from risk (balance * riskPercent) and SL in pips.
 * pipValue default 1.0 (adjust if you have symbol-specific pip value).
 */
function calculateLotFromRisk(balance = 0, riskPercent = 0.02, slPips = 50, pipValue = 1.0) {
  if (!balance || balance <= 0) return MIN_LOT;
  if (!slPips || slPips <= 0) return MIN_LOT;
  const riskAmount = balance * riskPercent;
  const lot = riskAmount / (slPips * pipValue);
  return roundLot(lot);
}

/**
 * Trade cooldown guard: returns true if allowed to take new trade
 * lastSignal shape: { type: 'BUY'|'SELL', m5CandleTime: <iso>, time: <iso> }
 */
function canTakeTrade(lastSignal, type, m5CandleTime, cooldownMinutes = COOLDOWN_MINUTES) {
  if (!lastSignal) return true;
  if (lastSignal.type !== type) return true;
  if (!m5CandleTime) return true;
  if (lastSignal.m5CandleTime === m5CandleTime) return false;
  const lastTime = new Date(lastSignal.time);
  const now = new Date();
  const diffMin = (now - lastTime) / 60000;
  if (diffMin < cooldownMinutes && lastSignal.type === type) return false;
  return true;
}

module.exports = {
  MIN_LOT,
  LOT_ROUND,
  safeLog,
  roundLot,
  computeAllowedRiskForNewTrade,
  calculateLotFromRisk,
  canTakeTrade,
  DEFAULT_MAX_TOTAL_RISK,
  DEFAULT_MAX_OPEN_TRADES,
  DEFAULT_RISK_PER_TRADE,
  COOLDOWN_MINUTES
};
