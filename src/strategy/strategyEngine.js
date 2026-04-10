const { evaluateRegime } = require('./engines/regimeEngine');
const { evaluateTrend } = require('./engines/trendEngine');
const { detectPullback } = require('./engines/pullbackEngine');
const { confirmMomentum } = require('./engines/momentumEngine');
const { evaluateLiquidity } = require('./engines/liquidityFilter');

const { evaluateScore } = require('./evaluation/scoreEvaluator');

const { getContext } = require('../core/symbolRegistry');

function runStrategy(symbol) {

  evaluateRegime(symbol);
  evaluateTrend(symbol);

  const ctx = getContext(symbol);
  const state = ctx.phase?.state || "IDLE";

  // Only run deeper logic when trend exists
  if (ctx.strategy.trend === "BUY" || ctx.strategy.trend === "SELL") {

    detectPullback(symbol);
    confirmMomentum(symbol);
    evaluateLiquidity(symbol);

  } else {
    // reset noisy signals when no trend
    ctx.strategy.pullbackSignal = null;
    ctx.strategy.momentum = "NONE";
  }

  let scoreResult = null;

  const setupReady =
    ctx.strategy.pullbackSignal === "BUY_READY" ||
    ctx.strategy.pullbackSignal === "SELL_READY" ||
    ctx.strategy.momentum === "BUY_CONFIRM" ||
    ctx.strategy.momentum === "SELL_CONFIRM";

  if (setupReady) {
    scoreResult = evaluateScore(symbol);
  }

  console.log('\n================ STRATEGY DEBUG ================');
  console.log('[CTX]', ctx.strategy);
  console.log('[SCORE]', scoreResult);
  console.log('================================================\n');

  return {
    ctx,
    scoreResult
  };
}

module.exports = {
  runStrategy
};