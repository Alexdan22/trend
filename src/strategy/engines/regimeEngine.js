const { getContext } = require('../../core/symbolRegistry');

const BB_DEAD_THRESHOLD = 0.0012;
const BB_TREND_THRESHOLD = 0.003;

function evaluateRegime(symbol) {

  const ctx = getContext(symbol);
  if (!ctx) return;

  const bb = ctx.indicators.bollinger;
  const atr = ctx.indicators.atr;

  if (!bb || !atr) return;

  const width = bb.width;

  let regime = "SIDEWAYS";

  if (width < BB_DEAD_THRESHOLD) {
    regime = "DEAD";
  }
  else if (width > BB_TREND_THRESHOLD) {
    regime = "TRENDING";
  }

  ctx.strategy.regime = regime;

}

module.exports = {
  evaluateRegime
};