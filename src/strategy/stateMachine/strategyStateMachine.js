const states = {
  IDLE: "IDLE",
  TREND: "TREND",
  PULLBACK: "PULLBACK",
  MOMENTUM: "MOMENTUM"
};

let currentState = states.IDLE;

function evaluateState(ctx, scoreResult) {

  switch (currentState) {

    case states.IDLE:
      if (ctx.trendBias === "BUY" || ctx.trendBias === "SELL") {
        currentState = states.TREND;
      }
      break;

    case states.TREND:
      if (ctx.pullbackDetected) {
        currentState = states.PULLBACK;
      }
      break;

    case states.PULLBACK:
      if (ctx.momentumConfirmed) {
        currentState = states.MOMENTUM;
      }
      break;

    case states.MOMENTUM:

      // 🔥 FINAL DECISION POINT
      if (scoreResult && scoreResult.signal) {
        currentState = states.IDLE; // reset after entry
        return {
          action: "ENTER",
          signal: scoreResult.signal,
          score: scoreResult.score
        };
      } else {
        // ❌ Score failed → reset to TREND
        currentState = states.TREND;
      }
      break;
  }

  return null;
}


function notifyTradeClosed() {

  lastTradeTime = Date.now();
  currentState = states.COOLDOWN;

}

function getState() {
  return currentState;
}

module.exports = {
  evaluateState,
  notifyTradeClosed,
  getState
};