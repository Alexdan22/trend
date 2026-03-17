const states = {
  IDLE: "IDLE",
  TREND: "TREND",
  PULLBACK: "PULLBACK",
  MOMENTUM: "MOMENTUM"
};

let currentState = states.IDLE;

function evaluateState(ctx, scoreResult) {

  const trend = ctx.strategy?.trend;
  const pullback = ctx.strategy?.pullback;
  const momentum = ctx.strategy?.momentum;

  switch (currentState) {

    case states.IDLE:
      if (trend === "BUY" || trend === "SELL") {
        currentState = states.TREND;
        console.log('[STATE] → TREND');
      }
      break;

    case states.TREND:
      if (pullback === true) {
        currentState = states.PULLBACK;
        console.log('[STATE] → PULLBACK');
      }
      break;

    case states.PULLBACK:
      if (
        momentum === "BUY_CONFIRM" ||
        momentum === "SELL_CONFIRM"
      ) {
        currentState = states.MOMENTUM;
        console.log('[STATE] → MOMENTUM');
      }
      break;

    case states.MOMENTUM:

      // 🔥 FINAL DECISION
      if (scoreResult && scoreResult.signal) {
        console.log('[STATE] → ENTER');

        currentState = states.IDLE;

        return {
          action: "ENTER",
          signal: scoreResult.signal,
          score: scoreResult.score
        };
      } else {
        console.log('[STATE] ❌ Score failed → back to TREND');

        currentState = states.TREND;
      }
      break;
  }

  return null;
}

function getState() {
  return currentState;
}

module.exports = {
  evaluateState,
  getState
};