const { getContext } = require('../../core/symbolRegistry');

function detectPullback(symbol) {
  const ctx = getContext(symbol);
  if (!ctx) return;

  const trend = ctx.strategy.trend;
  const stochastic = ctx.indicators.stochastic;

  if (stochastic == null) return;

  const pb = ctx.strategy.pullback;

  // initialize memory
  if (pb.lastStochastic === null) {
    pb.lastStochastic = stochastic;
    pb.active = false;
    return;
  }

  // ---------------- BUY PULLBACK ----------------
  if (trend === "BUY") {

    // Step 1: detect dip
    if (!pb.active && stochastic < 30) {
      pb.active = true;
      pb.direction = "BUY";
      console.log('[PULLBACK] BUY pullback started');
    }

    // Step 2: detect recovery (KEY)
    if (pb.active && stochastic > pb.lastStochastic) {
      ctx.strategy.pullbackSignal = "BUY_READY";

      console.log('[PULLBACK] BUY pullback completed');

      // reset
      pb.active = false;
      pb.direction = null;
    }
  }

  // ---------------- SELL PULLBACK ----------------
  else if (trend === "SELL") {

    // Step 1: detect spike
    if (!pb.active && stochastic > 70) {
      pb.active = true;
      pb.direction = "SELL";
      console.log('[PULLBACK] SELL pullback started');
    }

    // Step 2: detect drop (KEY)
    if (pb.active && stochastic < pb.lastStochastic) {
      ctx.strategy.pullbackSignal = "SELL_READY";

      console.log('[PULLBACK] SELL pullback completed');

      // reset
      pb.active = false;
      pb.direction = null;
    }
  }

  pb.lastStochastic = stochastic;
}

module.exports = {
  detectPullback
};