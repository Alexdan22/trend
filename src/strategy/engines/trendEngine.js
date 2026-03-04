const { getContext } = require('../../core/symbolRegistry');

/*
Trend Detection Engine

Outputs:
BUY
SELL
NONE
*/

function evaluateTrend(symbol) {

  const ctx = getContext(symbol);
  if (!ctx) return;

  const ema50 = ctx.indicators.ema50;
  const ema200 = ctx.indicators.ema200;
  const rsi = ctx.indicators.rsi;

  const candles = ctx.candles.m15;

  if (!ema50 || !ema200 || !rsi || candles.length === 0) return;

  const lastClose = candles[candles.length - 1].close;

  let trend = "NONE";

  if (
    ema50 > ema200 &&
    lastClose > ema50 &&
    rsi >= 55
  ) {
    trend = "BUY";
  }

  else if (
    ema50 < ema200 &&
    lastClose < ema50 &&
    rsi <= 45
  ) {
    trend = "SELL";
  }

  ctx.strategy.trend = trend;
}

module.exports = {
  evaluateTrend
};