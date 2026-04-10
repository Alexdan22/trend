const states = {
  IDLE: "IDLE",
  TREND: "TREND",
  SETUP: "SETUP"
};

let currentState = states.IDLE;
let trendBias = null;
let setupStartTime = null;

const SETUP_TIMEOUT = 5 * 60 * 1000; // 5 minutes

function evaluateState(ctx, scoreResult) {
  const { trend, pullback, momentum } = ctx.strategy;

  console.log('[STATE DEBUG]', {
    currentState,
    trend,
    pullback,
    momentum,
    score: scoreResult?.score
  });

  switch (currentState) {

    // ---------------- IDLE ----------------
    case states.IDLE:
      if (trend === "BUY" || trend === "SELL") {
        trendBias = trend;
        currentState = states.TREND;

        console.log(`[STATE] IDLE → TREND (${trendBias})`);
      }
      break;

    // ---------------- TREND ----------------
    case states.TREND:
      // trend must remain stable
      if (trend !== trendBias) {
        console.log('[STATE] TREND invalidated → IDLE');
        resetState();
        break;
      }

      // move immediately to setup phase
      currentState = states.SETUP;
      setupStartTime = Date.now();

      console.log('[STATE] TREND → SETUP');
      break;

    // ---------------- SETUP ----------------
    case states.SETUP:

      // timeout safety
      if (Date.now() - setupStartTime > SETUP_TIMEOUT) {
        console.log('[STATE] SETUP timeout → TREND reset');
        currentState = states.TREND;
        setupStartTime = Date.now();
        break;
      }

      // trend must still hold
      if (trend !== trendBias) {
        console.log('[STATE] SETUP invalidated (trend flip) → IDLE');
        resetState();
        break;
      }

      // ✅ FLEXIBLE CONDITION (KEY CHANGE)
      const setupReady =
        pullback === true ||
        momentum === "BUY_CONFIRM" ||
        momentum === "SELL_CONFIRM";

      if (!setupReady) break;

      console.log('[STATE] SETUP condition met');

      // ---------------- ENTRY DECISION ----------------
      if (scoreResult && scoreResult.signal && scoreResult.score >= 5) {

        console.log('[STATE] ENTRY TRIGGERED', scoreResult);

        const action = {
          action: "ENTER",
          signal: scoreResult.signal,
          score: scoreResult.score
        };

        resetState();
        return action;
      }

      break;
  }

  return null;
}

function resetState() {
  currentState = states.IDLE;
  trendBias = null;
  setupStartTime = null;
}

function getState() {
  return currentState;
}

function notifyTradeClosed() {
  console.log('[STATE] Trade closed → resetting state');
  resetState();
}

module.exports = {
  evaluateState,
  getState,
  notifyTradeClosed
};