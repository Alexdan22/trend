const { getContext } = require('./symbolRegistry');

function calculateEMA(values, period) {

  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let ema = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

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

  return 100 - (100 / (1 + rs));
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

  return ((lastClose - lowestLow) /
    (highestHigh - lowestLow)) * 100;
}

function calculateBollingerBands(values, period = 20, mult = 2) {

  if (values.length < period) return null;

  const slice = values.slice(-period);

  const mean =
    slice.reduce((a, b) => a + b, 0) / period;

  const variance =
    slice.reduce((sum, v) =>
      sum + Math.pow(v - mean, 2), 0) / period;

  const std = Math.sqrt(variance);

  return {
    upper: mean + mult * std,
    lower: mean - mult * std,
    middle: mean,
    width: (2 * mult * std) / mean
  };
}

function calculateATR(candles, period = 14) {

  if (candles.length < period + 1) return null;

  const trs = [];

  for (let i = candles.length - period; i < candles.length; i++) {

    const curr = candles[i];
    const prev = candles[i - 1];

    const highLow = curr.high - curr.low;
    const highClose = Math.abs(curr.high - prev.close);
    const lowClose = Math.abs(curr.low - prev.close);

    trs.push(Math.max(highLow, highClose, lowClose));
  }

  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;

  return atr;
}

function updateIndicators(symbol) {

  const ctx = getContext(symbol);
  if (!ctx) return;

  const candles = ctx.candles.m5;
  if (!candles || candles.length < 200) return;

  const closes = candles.map(c => c.close);

  ctx.indicators.ema50 = calculateEMA(closes, 50);
  ctx.indicators.ema200 = calculateEMA(closes, 200);
  ctx.indicators.rsi = calculateRSI(closes, 14);
  ctx.indicators.stochastic = calculateStochastic(candles, 14);
  ctx.indicators.bollinger = calculateBollingerBands(closes, 20, 2);
  ctx.indicators.atr = calculateATR(candles, 14);

}

module.exports = {
  updateIndicators
};