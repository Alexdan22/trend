const { evaluateRegime } = require('./engines/regimeEngine');
const { evaluateTrend } = require('./engines/trendEngine');
const { detectPullback } = require('./engines/pullbackEngine');
const { confirmMomentum } = require('./engines/momentumEngine');
const { evaluateLiquidity } = require('./engines/liquidityFilter');

const { evaluateScore } = require('./evaluation/scoreEvaluator');

function runStrategy(symbol) {

  const regime = evaluateRegime(symbol);
  const trend = evaluateTrend(symbol);
  const pullback = detectPullback(symbol);
  const momentum = confirmMomentum(symbol);
  const liquidity = evaluateLiquidity(symbol);

  console.log('\n================ STRATEGY DEBUG ================');
  console.log('[ENGINE] Regime:', regime);
  console.log('[ENGINE] Trend:', trend);
  console.log('[ENGINE] Pullback:', pullback);
  console.log('[ENGINE] Momentum:', momentum);
  console.log('[ENGINE] Liquidity:', liquidity);
  console.log('[ENGINE] Score Result:', result);
  console.log('================================================\n');

  if (!result) {
    console.log('[STRATEGY] ❌ No signal generated\n');
    return null;
  }

  console.log('[STRATEGY] ✅ Signal:', result.signal, '| Score:', result.score, '\n');

  const ctx = getContext(symbol);
  const scoreResult = evaluateScore(symbol);

  return {
    ctx,
    scoreResult
  };
}

module.exports = {
  runStrategy
};