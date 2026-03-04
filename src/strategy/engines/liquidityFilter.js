const { getContext } = require('../../core/symbolRegistry');

/*
Liquidity Filter

Blocks trading when market conditions are poor
*/

const MAX_SPREAD = 0.5;
const MIN_ATR = 0.3;

function evaluateLiquidity(symbol) {

  const ctx = getContext(symbol);
  if (!ctx) return;

  const spread = ctx.price.spread;
  const atr = ctx.indicators.atr;

  if (spread === null || atr === null) {
    ctx.strategy.liquidity = "BLOCK";
    return;
  }

  let liquidity = "PASS";

  if (spread > MAX_SPREAD) {
    liquidity = "BLOCK";
  }

  if (atr < MIN_ATR) {
    liquidity = "BLOCK";
  }

  ctx.strategy.liquidity = liquidity;
}

module.exports = {
  evaluateLiquidity
};