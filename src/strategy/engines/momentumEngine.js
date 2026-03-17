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

  const bullishCandle = last.close > last.open;
  const bearishCandle = last.close < last.open;

  const stochasticRising = stochasticNow > stochasticPrev;
  const stochasticFalling = stochasticNow < stochasticPrev;

  const rsiBullish = rsi !== null && rsi > 50;
  const rsiBearish = rsi !== null && rsi < 50;

  if (trend === "BUY") {

    if (
      (stochasticRising && rsiBullish) ||   // strong confirmation
      (bullishCandle && rsiBullish)         // fallback confirmation
    ) {
      momentum = "BUY_CONFIRM";
    }

  }

  else if (trend === "SELL") {

    if (
      (stochasticFalling && rsiBearish) ||
      (bearishCandle && rsiBearish)
    ) {
      momentum = "SELL_CONFIRM";
    }

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