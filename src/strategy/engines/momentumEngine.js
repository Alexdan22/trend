const { getContext } = require('../../core/symbolRegistry');

/*
Momentum Confirmation Engine

Outputs:
BUY_CONFIRM
SELL_CONFIRM
NONE
*/

function confirmMomentum(symbol) {

  const ctx = getContext(symbol);
  if (!ctx) return;

  const trend = ctx.strategy.trend;
  const pullback = ctx.strategy.pullback;

  if (!pullback || trend === "NONE") {
    ctx.strategy.momentum = "NONE";
    return;
  }

  const candles = ctx.candles.m5;
  const rsi = ctx.indicators.rsi;

  if (!candles || candles.length < 2 || rsi === null) return;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const stochasticNow = ctx.indicators.stochastic;

  const prevCandles = candles.slice(0, -1);
  const stochasticPrev = calculateStochastic(prevCandles, 14);

  let momentum = "NONE";

  if (
    trend === "BUY" &&
    stochasticPrev <= 20 &&
    stochasticNow > 20 &&
    last.close > last.open
  ) {
    momentum = "BUY_CONFIRM";
  }

  else if (
    trend === "SELL" &&
    stochasticPrev >= 80 &&
    stochasticNow < 80 &&
    last.close < last.open
  ) {
    momentum = "SELL_CONFIRM";
  }

  ctx.strategy.momentum = momentum;
}

/*
Helper (same logic used in indicator engine)
*/

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

module.exports = {
  confirmMomentum
};