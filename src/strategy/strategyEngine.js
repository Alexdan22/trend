const CONFIG = {
  THRESHOLD: 60,          // ↓ lowered from 75
  MEMORY_LIMIT: 15,       // ↓ more reactive
  DECAY: 0.6,
  SCORING_TIMEOUT: 10 * 60 * 1000 // 10 min
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

  // 🔒 LOCKED SCORES
  lockedScores: {
    trend: 0,
    setup: 0
  },

  // LIVE
  liveScore: {
    momentum: 0
  },

  scoringStartTime: null
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

  state.lockedScores = {
    trend: 0,
    setup: 0
  };

  state.liveScore = {
    momentum: 0
  };

  state.scoringStartTime = null;
}

// ==============================
// SCORING FUNCTIONS (UNCHANGED CORE)
// ==============================

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

  return Math.min(30,
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
      if (stochastic < 35) score += 2;
      if (rsi < 45) score += 1;
    } else {
      if (stochastic > 65) score += 2;
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
      if (delta > 0) score += 4;
      if (Math.abs(delta) > 5) score += 3;
      if (rsi > 50) score += 1;
    } else {
      if (delta < 0) score += 4;
      if (Math.abs(delta) > 5) score += 3;
      if (rsi < 50) score += 1;
    }
  }

  return Math.min(40, score);
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

  const prevStoch = state.prevStochastic;
  state.prevStochastic = stochastic;

  // ==============================
  // BLOCKERS
  // ==============================
  if (!price || !ema50 || !ema200 || !bollinger || rsi == null || stochastic == null) {
    return { action: null };
  }

  // ATR filter (important)
  if (atr && atr < 1.5) {
    return { action: null };
  }

  // ==============================
  // IDLE → TREND
  // ==============================
  if (state.phase === "IDLE") {

    if (ema50 > ema200) {
      state.phase = "TREND";
      state.signal = "BUY";
    }

    if (ema50 < ema200) {
      state.phase = "TREND";
      state.signal = "SELL";
    }
    console.log("[Phase] → TREND", state.signal);

    return { action: null };
  }

  // ==============================
  // TREND
  // ==============================
  if (state.phase === "TREND") {

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

    const pullbackTriggered =
      (state.signal === "BUY" && stochastic < 35) ||
      (state.signal === "SELL" && stochastic > 65);

    if (pullbackTriggered && state.memory.trend.length >= 3) {

      state.lockedScores.trend = computeTrendScore(state.memory.trend);

      state.memory.trend = decay(state.memory.trend);
      state.phase = "SETUP";
      console.log("[TREND] Locked Trend Score:", state.lockedScores.trend.toFixed(2));
      console.log("[Phase] → SETUP");

      return { action: null };
    }
  }

  // ==============================
  // SETUP
  // ==============================
  if (state.phase === "SETUP") {

    state.memory.setup.push({ stochastic, rsi });
    trim(state.memory.setup);

    if (state.memory.setup.length < 2) {
      return { action: null };
    }

    const recoveryTriggered =
      (state.signal === "BUY" && stochastic > 35) ||
      (state.signal === "SELL" && stochastic < 65);

    if (recoveryTriggered) {

      state.lockedScores.setup = computeSetupScore(
        state.memory.setup,
        state.signal
      );

      state.memory.setup = decay(state.memory.setup);
      state.phase = "SCORING";
      state.scoringStartTime = Date.now();
      console.log("[SETUP] Locked Setup Score:", state.lockedScores.setup.toFixed(2));
      console.log("[Phase] → SCORING");

      return { action: null };
    }
  }

  // ==============================
  // SCORING (ONLY MOMENTUM LIVE)
// ==============================
if (state.phase === "SCORING") {

  // Collect momentum
  state.memory.momentum.push({
    delta: indicators.stochasticDelta || 0,
    rsi
  });

  trim(state.memory.momentum);

  state.liveScore.momentum = computeMomentumScore(
    state.memory.momentum,
    state.signal
  );

  const finalScore =
    state.lockedScores.trend +
    state.lockedScores.setup +
    state.liveScore.momentum;

  console.log("[SCORING]", {
    finalScore,
    locked: state.lockedScores,
    momentum: state.liveScore.momentum
  });

  // ENTRY
  if (finalScore >= CONFIG.THRESHOLD) {
    const result = {
      action: "ENTER",
      signal: state.signal,
      score: finalScore
    };

    reset();
    console.log("[SCORING] Final Score:", finalScore.toFixed(2));
    return result;
  }

  // TIMEOUT EXIT
  if (Date.now() - state.scoringStartTime > CONFIG.SCORING_TIMEOUT) {
    reset();
    console.log("[SCORING] Timeout reached");
    return { action: null };
  }

  // MOMENTUM COLLAPSE
  if (state.liveScore.momentum < 5) {
    reset();
    console.log("[SCORING] Momentum collapsed");
    return { action: null };
  }
}

  return { action: null };
}

module.exports = { strategyEngine };