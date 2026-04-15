const CONFIG = {
  THRESHOLD: 75,
  MEMORY_LIMIT: 20,
  DECAY: 0.6
};

// ==============================
// STATE (persistent)
// ==============================
const state = {
  phase: "IDLE",
  signal: null,

  prevStochastic: null,

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
// HELPERS
// ==============================

function trim(arr) {
  if (arr.length > CONFIG.MEMORY_LIMIT) {
    arr.splice(0, arr.length - CONFIG.MEMORY_LIMIT);
  }
}

function decay(arr) {
  return arr.map(item => {
    const decayed = {};
    for (const key in item) {
      decayed[key] = item[key] * CONFIG.DECAY;
    }
    return decayed;
  });
}

function reset() {
  state.phase = "IDLE";
  state.signal = null;

  state.memory = {
    trend: [],
    setup: [],
    momentum: []
  };

  state.scores = {
    trend: 0,
    setup: 0,
    momentum: 0
  };
}

function computeTrendScore(memory) {
  if (!memory.length) return 0;

  const avg = memory.reduce((acc, m) => {
    acc.emaDiff += m.emaDiff || 0;
    acc.priceDistance += m.priceDistance || 0;
    acc.bbWidth += m.bbWidth || 0;
    return acc;
  }, { emaDiff: 0, priceDistance: 0, bbWidth: 0 });

  const n = memory.length;

  const emaScore = avg.emaDiff / n;
  const distScore = avg.priceDistance / n;
  const volScore = avg.bbWidth / n;

  // Normalize (tune later)
  return Math.min(40,
    (emaScore * 10) +
    (distScore * 5) +
    (volScore * 100)
  );
}

function computeSetupScore(memory, signal) {
  if (!memory.length) return 0;

  let score = 0;

  for (const m of memory) {
    const { stochastic, rsi } = m;

    if (signal === "BUY") {
      if (stochastic < 30) score += 2;
      if (rsi < 45) score += 1;
    } else {
      if (stochastic > 70) score += 2;
      if (rsi > 55) score += 1;
    }
  }

  return Math.min(30, score);
}

function computeMomentumScore(memory, signal) {
  if (!memory.length) return 0;

  let score = 0;

  for (const m of memory) {
    const { delta, rsi } = m;

    if (signal === "BUY") {
      if (delta > 0) score += 2;
      if (rsi > 50) score += 1;
    } else {
      if (delta < 0) score += 2;
      if (rsi < 50) score += 1;
    }
  }

  return Math.min(30, score);
}

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
  const prevStoch = state.prevStochastic;
  state.prevStochastic = stochastic;

  // ==============================
  // IDLE → TREND
  // ==============================
  if (state.phase === "IDLE") {
    if (ema50 > ema200) {
      state.phase = "TREND";
      state.signal = "BUY";
      return { action: null }; // 🔴 stop execution
    } else if (ema50 < ema200) {
      state.phase = "TREND";
      state.signal = "SELL";
      return { action: null };
    }
  }

  // ==============================
  // TREND PHASE
  // ==============================
  else if (state.phase === "TREND") {
    state.memory.trend.push({
      emaDiff: Math.abs(ema50 - ema200),
      priceDistance: Math.abs(price - ema50),
      bbWidth: bollinger.width || 0
    });

    trim(state.memory.trend);

    // Trend invalidation
    if (
      (state.signal === "BUY" && ema50 < ema200) ||
      (state.signal === "SELL" && ema50 > ema200)
    ) {
      reset();
      return { action: null };
    }

    // 🔴 REQUIRE CROSS into pullback zone
    const pullbackTriggered =
      prevStoch !== null &&
      (
        (state.signal === "BUY" && prevStoch > 30 && stochastic <= 30) ||
        (state.signal === "SELL" && prevStoch < 70 && stochastic >= 70)
      );

    if (pullbackTriggered && state.memory.trend.length >= 5) {
      state.scores.trend = computeTrendScore(state.memory.trend);
      state.memory.trend = decay(state.memory.trend);

      state.phase = "SETUP";
      return { action: null }; // 🔴 stop here
    }
  }

  // ==============================
  // SETUP PHASE
  // ==============================
  else if (state.phase === "SETUP") {
    state.memory.setup.push({ stochastic, rsi });
    trim(state.memory.setup);

    // 🔴 stay in setup until enough structure
    if (state.memory.setup.length < 5) {
      return { action: null };
    }

    // 🔴 REQUIRE CROSS OUT of pullback
    const recoveryTriggered =
      prevStoch !== null &&
      (
        (state.signal === "BUY" && prevStoch <= 30 && stochastic > 30) ||
        (state.signal === "SELL" && prevStoch >= 70 && stochastic < 70)
      );

    if (recoveryTriggered) {
      state.scores.setup = computeSetupScore(
        state.memory.setup,
        state.signal
      );

      state.memory.setup = decay(state.memory.setup);

      state.phase = "SCORING";
      return { action: null }; // 🔴 stop here
    }
  }

  // ==============================
  // MOMENTUM COLLECTION
  // ==============================
  if (state.phase === "SETUP" || state.phase === "SCORING") {
    state.memory.momentum.push({
      delta: indicators.stochasticDelta || 0,
      rsi
    });

    trim(state.memory.momentum);
  }

  // ==============================
  // SCORING PHASE
  // ==============================
  else if (state.phase === "SCORING") {
    state.scores.momentum = computeMomentumScore(
      state.memory.momentum,
      state.signal
    );

    const finalScore =
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
      }
    });

    if (finalScore >= CONFIG.THRESHOLD) {
      const result = {
        action: "ENTER",
        signal: state.signal,
        score: finalScore
      };

      reset();
      return result;
    }

    // ❌ DO NOT RESET
    // stay in scoring and continue building
    return { action: null };
  }

  return { action: null };
}


module.exports = { strategyEngine };