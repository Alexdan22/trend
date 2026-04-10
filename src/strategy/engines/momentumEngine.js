const { getContext } = require('../../core/symbolRegistry');

function confirmMomentum(symbol) {
  const ctx = getContext(symbol);
  if (!ctx) return;

  const trend = ctx.strategy.trend;
  const rsi = ctx.indicators.rsi;
  const stochastic = ctx.indicators.stochastic;

  const candles = ctx.candles.m5;

  if (!stochastic || !rsi || candles.length < 3) {
    ctx.strategy.momentum = "NONE";
    return;
  }

  const prevStoch = ctx.strategy._prevStoch ?? stochastic;
  const stochDelta = stochastic - prevStoch;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const bullishCandle = last.close > last.open;
  const bearishCandle = last.close < last.open;

  let momentum = "NONE";

  // ---------------- BUY MOMENTUM ----------------
  if (trend === "BUY") {

    const stochRising = stochDelta > 3;          // strength threshold
    const rsiSupport = rsi > 50;

    if (
      stochRising &&
      rsiSupport &&
      bullishCandle
    ) {
      momentum = "BUY_CONFIRM";
    }
  }

  // ---------------- SELL MOMENTUM ----------------
  else if (trend === "SELL") {

    const stochFalling = stochDelta < -3;
    const rsiSupport = rsi < 50;

    if (
      stochFalling &&
      rsiSupport &&
      bearishCandle
    ) {
      momentum = "SELL_CONFIRM";
    }
  }

  ctx.strategy.momentum = momentum;

  ctx.strategy._prevStoch = stochastic;

  console.log('[MOMENTUM]', {
    trend,
    stochastic,
    delta: stochDelta.toFixed(2),
    rsi,
    momentum
  });
}

module.exports = {
  confirmMomentum
};