const states = {
  IDLE: "IDLE",
  READY: "READY",
  TRADE_ACTIVE: "TRADE_ACTIVE",
  COOLDOWN: "COOLDOWN"
};

let currentState = states.IDLE;
let lastTradeTime = 0;

const COOLDOWN_MS = 60 * 1000; // 1 minute

function evaluateState(strategyResult) {

  const now = Date.now();

  switch (currentState) {

    case states.IDLE:

      if (strategyResult && strategyResult.signal) {
        currentState = states.READY;

        return {
          action: "ENTER",
          signal: strategyResult.signal,
          score: strategyResult.score
        };
      }

      break;

    case states.READY:

      currentState = states.TRADE_ACTIVE;

      return {
        action: "EXECUTE"
      };

    case states.TRADE_ACTIVE:

      return {
        action: "HOLD"
      };

    case states.COOLDOWN:

      if (now - lastTradeTime > COOLDOWN_MS) {
        currentState = states.IDLE;
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