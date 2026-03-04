const { evaluateRegime } = require('./engines/regimeEngine');
const { evaluateTrend } = require('./engines/trendEngine');
const { detectPullback } = require('./engines/pullbackEngine');
const { confirmMomentum } = require('./engines/momentumEngine');
const { evaluateLiquidity } = require('./engines/liquidityFilter');

const { evaluateScore } = require('./evaluation/scoreEvaluator');

function runStrategy(symbol) {

  // Run engines sequentially
  evaluateRegime(symbol);
  evaluateTrend(symbol);
  detectPullback(symbol);
  confirmMomentum(symbol);
  evaluateLiquidity(symbol);

  // Evaluate score
  const result = evaluateScore(symbol);

  if (!result) return null;

  return {
    signal: result.signal,
    score: result.score
  };
}

module.exports = {
  runStrategy
};