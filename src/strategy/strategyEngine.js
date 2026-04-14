const CONFIG = {
  THRESHOLD: 75,
  MEMORY_LIMIT: 20,     // max candles per phase
  DECAY: 0.6           // partial carry-over (0.5–0.8 range)
};

// ==============================
// HELPERS
// ==============================
function clamp(v, min = 0, max = 1) {
  return Math.max(min, Math.min(v, max));
}

function scale10(v) {
  return clamp(v) * 10;
}

function avg(arr, key) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x[key], 0) / arr.length;
}

// ==============================
// STATE (persistent)
// ==============================
const state = {
  phase: "IDLE",
  signal: null,

  memory: {
    trend: [],
    setup: [],
    momentum: []
  },

  scores: {
    trend: 0,
    setup: 0,
    momentum: 0
  }
};

// ==============================
// ENGINE
// ==============================
function strategyEngine(ctx) {
  const { indicators } = ctx;
  const price = ctx.price?.bid || ctx.price?.ask;

  const {
    ema50,
    ema200,
    rsi,
    stochastic,
    bollinger,
    atr
  } = indicators;

  if (
    !price ||
    !ema50 ||
    !ema200 ||
    !bollinger ||
    rsi == null ||
    stochastic == null
  ) {
    return { action: null };
  }

  let action = null;

  // ==============================
  // IDLE → TREND
  // ==============================
  if (state.phase === "IDLE") {
    if (ema50 > ema200) {
      state.phase = "TREND";
      state.signal = "BUY";
    } else if (ema50 < ema200) {
      state.phase = "TREND";
      state.signal = "SELL";
    }
  }

  // ==============================
  // TREND PHASE
  // ==============================
  if (state.phase === "TREND") {
    state.memory.trend.push({
      emaDiff: Math.abs(ema50 - ema200),
      priceDistance: Math.abs(price - ema50),
      bbWidth: bollinger.width || 0
    });

    trim(state.memory.trend);

    if (
      (state.signal === "BUY" && ema50 < ema200) ||
      (state.signal === "SELL" && ema50 > ema200)
    ) {
      console.log("[RESET] Trend invalidated");
      reset();
      return { action: null };
    }

    // Transition condition
    if (
      (state.signal === "BUY" && stochastic < 50) ||
      (state.signal === "SELL" && stochastic > 50)
    ) {
      state.scores.trend = computeTrendScore(state.memory.trend);
      state.memory.trend = decay(state.memory.trend);

      state.phase = "SETUP";
      console.log(`[PHASE] TREND → SETUP`);
    }
  }

  // ==============================
  // SETUP PHASE
  // ==============================
  if (state.phase === "SETUP") {
    state.memory.setup.push({ stochastic, rsi });

    trim(state.memory.setup);

    if (
      (state.signal === "BUY" && stochastic > 20) ||
      (state.signal === "SELL" && stochastic < 80)
    ) {
      state.scores.setup = computeSetupScore(
        state.memory.setup,
        state.signal
      );

      state.memory.setup = decay(state.memory.setup);

      state.phase = "SCORING";
      console.log(`[PHASE] SETUP → SCORING`);
    }
  }

  // ==============================
  // MOMENTUM COLLECTION
  // ==============================
  let finalScore = 0;
  if (state.phase === "SETUP" || state.phase === "SCORING") {
    state.memory.momentum.push({
      delta: indicators.stochasticDelta || 0,
      rsi
    });

    trim(state.memory.momentum);
  }

  // ==============================
  // SCORING
  // ==============================
  if (state.phase === "SCORING") {
    state.scores.momentum = computeMomentumScore(
      state.memory.momentum,
      state.signal
    );

    finalScore =
      state.scores.trend +
      state.scores.setup +
      state.scores.momentum;

    console.log("[ENGINE]", {
      phase: state.phase,
      signal: state.signal,
      score: finalScore,
      scores: state.scores,
      memorySizes: {
        trend: state.memory.trend.length,
        setup: state.memory.setup.length,
        momentum: state.memory.momentum.length
      },
      indicators: {
        rsi,
        stochastic,
        delta: indicators.stochasticDelta,
        atr
      }
    });

    if (finalScore >= CONFIG.THRESHOLD) {
      action = "ENTER";
    } else {
      reset();
    }
  }

  if (action === "ENTER") {
    const result = {
      action,
      signal: state.signal,
      score: finalScore
    };

    reset(); // reset AFTER capturing result
    return result;
  }
  return { action: null };
}

// ==============================
// SCORING FUNCTIONS (AVG BASED)
// ==============================
function computeTrendScore(mem) {
  const emaScore = scale10(avg(mem, "emaDiff") / 0.002);
  const priceScore = scale10(avg(mem, "priceDistance") / 0.003);
  const bbScore = scale10(avg(mem, "bbWidth") / 0.01);

  return emaScore + priceScore + bbScore;
}

function computeSetupScore(mem, signal) {
  const avgStoch = avg(mem, "stochastic");
  const avgRsi = avg(mem, "rsi");

  const depthScore = scale10(Math.abs(avgStoch - 50) / 50);

  let structureScore = 0;
  if (signal === "BUY") {
    structureScore = avgStoch < 50 ? 7 : -5;
  } else {
    structureScore = avgStoch > 50 ? 7 : -5;
  }

  const rsiScore = scale10(
    signal === "BUY"
      ? (avgRsi - 40) / 30
      : (60 - avgRsi) / 30
  );

  return depthScore + structureScore + rsiScore;
}

function computeMomentumScore(mem, signal) {
  const valid = mem.filter(m =>
    (signal === "BUY" && m.delta > 0) ||
    (signal === "SELL" && m.delta < 0)
  );

  if (!valid.length) return 0;

  const avgDelta =
    valid.reduce((s, x) => s + Math.abs(x.delta), 0) / valid.length;

  const avgRsi = avg(valid, "rsi");

  const stochScore = scale10(avgDelta / 5);
  const rsiScore = scale10(Math.abs(avgRsi - 50) / 50);

  return stochScore + rsiScore;
}

// ==============================
// UTILITIES
// ==============================
function trim(arr) {
  if (arr.length > CONFIG.MEMORY_LIMIT) {
    arr.shift();
  }
}

function decay(arr) {
  const keep = Math.floor(arr.length * CONFIG.DECAY);
  return arr.slice(-keep);
}

function reset() {
  state.phase = "IDLE";
  state.signal = null;

  state.scores = {
    trend: 0,
    setup: 0,
    momentum: 0
  };

  state.memory = {
    trend: [],
    setup: [],
    momentum: []
  };
}

module.exports = { strategyEngine };