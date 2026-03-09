// src/core/indicatorEngine.js

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

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
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
    slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;

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
    width: (2 * mult * std) / mid
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

function computeATR_M5(candles, period = 14) {

  if (candles.length < period + 1) return 0;

  const start = candles.length - period;

  const trs = [];

  for (let i = start; i < candles.length; i++) {

    const curr = candles[i];
    const prev = candles[i - 1];

    const highLow = curr.high - curr.low;
    const highClose = Math.abs(curr.high - prev.close);
    const lowClose = Math.abs(curr.low - prev.close);

    const tr = Math.max(highLow, highClose, lowClose);

    trs.push(tr);
  }

  if (!trs.length) return 0;

  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

module.exports = {
  calculateEMA,
  calculateRSI,
  calculateSMA,
  calculateStdDev,
  calculateBollingerBands,
  calculateStochastic,
  computeATR_M5
};