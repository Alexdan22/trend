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
  detectPullback(symbol);
  confirmMomentum(symbol);
  evaluateLiquidity(symbol);

  const ctx = getContext(symbol);
  const scoreResult = evaluateScore(symbol);

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