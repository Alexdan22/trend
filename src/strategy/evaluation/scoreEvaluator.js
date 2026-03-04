const { getContext } = require('../../core/symbolRegistry');

const SCORE_THRESHOLD = 6;

function evaluateScore(symbol) {

  const ctx = getContext(symbol);
  if (!ctx) return null;

  const regime = ctx.strategy.regime;
  const trend = ctx.strategy.trend;
  const pullback = ctx.strategy.pullback;
  const momentum = ctx.strategy.momentum;
  const liquidity = ctx.strategy.liquidity;
  const atr = ctx.indicators.atr;

  let score = 0;

  if (regime === "TRENDING") {
    score += 2;
  }

  if (trend === "BUY" || trend === "SELL") {
    score += 2;
  }

  if (pullback === true) {
    score += 2;
  }

  if (momentum === "BUY_CONFIRM" || momentum === "SELL_CONFIRM") {
    score += 2;
  }

  if (liquidity === "PASS") {
    score += 1;
  }

  if (atr && atr > 0.3) {
    score += 1;
  }

  let signal = null;

  if (score >= SCORE_THRESHOLD) {

    if (momentum === "BUY_CONFIRM") {
      signal = "BUY";
    }

    if (momentum === "SELL_CONFIRM") {
      signal = "SELL";
    }
  }

  return {
    signal,
    score
  };
}

module.exports = {
  evaluateScore
};