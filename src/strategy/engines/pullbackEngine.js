const { getContext } = require('../../core/symbolRegistry');

/*
Pullback Detection Engine

Outputs:
true  → pullback detected
false → no pullback
*/

function detectPullback(symbol) {

  const ctx = getContext(symbol);
  if (!ctx) return;

  const trend = ctx.strategy.trend;
  const stochastic = ctx.indicators.stochastic;

  if (!trend || stochastic === null) return;

  let pullback = false;

  if (trend === "BUY" && stochastic <= 20) {
    pullback = true;
  }

  else if (trend === "SELL" && stochastic >= 80) {
    pullback = true;
  }

  ctx.strategy.pullback = pullback;
}

module.exports = {
  detectPullback
};