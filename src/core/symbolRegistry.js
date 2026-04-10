const symbols = new Map();

function createEmptyContext(symbol) {
  return {
    symbol,

    price: {
      bid: null,
      ask: null,
      spread: null,
      timestamp: null
    },

    candles: {
      m1: [],
      m5: [],
      m15: []
    },

    indicators: {
      ema50: null,
      ema200: null,
      rsi: null,
      stochastic: null,
      bollinger: {
        upper: null,
        middle: null,
        lower: null,
        width: null
      },
      atr: null
    },

    strategy: {
      regime: null,
      trend: null,
      pullback: {
        active: false,
        direction: null,     // BUY or SELL
        lastStochastic: null
      },
      momentum: null
    },

    phase: {
      state: "IDLE",          // IDLE | TREND | SETUP
      trendBias: null,        // BUY | SELL
      pullbackSeen: false,
      momentumSeen: false,
      setupReady: false,
      lastTransition: null
    },

    risk: {
      atrOk: true,
      liquidityOk: true,
      entryAllowed: true
    }
  };
}

function initSymbol(symbol) {
  if (!symbols.has(symbol)) {
    symbols.set(symbol, createEmptyContext(symbol));
  }
}

function getContext(symbol) {
  return symbols.get(symbol);
}

function updatePrice(symbol, bid, ask, timestamp) {
  const ctx = symbols.get(symbol);
  if (!ctx) return;

  ctx.price.bid = bid;
  ctx.price.ask = ask;
  ctx.price.spread = Math.abs(ask - bid);
  ctx.price.timestamp = timestamp;
}

function getAllSymbols() {
  return Array.from(symbols.keys());
}

module.exports = {
  initSymbol,
  getContext,
  updatePrice,
  getAllSymbols
};