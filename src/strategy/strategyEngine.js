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

  // ==============================
  // GLOBAL DEBUG SNAPSHOT
  // ==============================
  console.log("[TICK]", {
    phase: state.phase,
    signal: state.signal,
    price,
    ema50,
    ema200,
    rsi,
    stochastic,
    memorySizes: {
      trend: state.memory.trend.length,
      setup: state.memory.setup.length,
      momentum: state.memory.momentum.length
    }
  });

  // ==============================
  // BLOCKERS
  // ==============================
  if (!price) {
    console.log("[BLOCK] Missing price");
    return { action: null };
  }

  if (!ema50 || !ema200) {
    console.log("[BLOCK] EMA missing", { ema50, ema200 });
    return { action: null };
  }

  if (!bollinger) {
    console.log("[BLOCK] Bollinger missing");
    return { action: null };
  }

  if (rsi == null || stochastic == null) {
    console.log("[BLOCK] RSI/Stoch missing", { rsi, stochastic });
    return { action: null };
  }

  const prevStoch = state.prevStochastic;
  state.prevStochastic = stochastic;

  // ==============================
  // IDLE → TREND
  // ==============================
  if (state.phase === "IDLE") {
    console.log("[PHASE] IDLE");

    if (ema50 > ema200) {
      console.log("[TRANSITION] IDLE → TREND (BUY)", { ema50, ema200 });
      state.phase = "TREND";
      state.signal = "BUY";
      return { action: null };
    }

    if (ema50 < ema200) {
      console.log("[TRANSITION] IDLE → TREND (SELL)", { ema50, ema200 });
      state.phase = "TREND";
      state.signal = "SELL";
      return { action: null };
    }

    console.log("[IDLE] No trend detected");
  }

  // ==============================
  // TREND
  // ==============================
  else if (state.phase === "TREND") {
    console.log("[PHASE] TREND", { signal: state.signal });

    state.memory.trend.push({
      emaDiff: Math.abs(ema50 - ema200),
      priceDistance: Math.abs(price - ema50),
      bbWidth: bollinger.width || 0
    });

    trim(state.memory.trend);

    // Invalidation
    if (
      (state.signal === "BUY" && ema50 < ema200) ||
      (state.signal === "SELL" && ema50 > ema200)
    ) {
      console.log("[RESET] Trend invalidated", {
        signal: state.signal,
        ema50,
        ema200
      });
      reset();
      return { action: null };
    }

    const pullbackTriggered =
      prevStoch !== null &&
      (
        (state.signal === "BUY" && prevStoch > 30 && stochastic <= 30) ||
        (state.signal === "SELL" && prevStoch < 70 && stochastic >= 70)
      );

    console.log("[TREND]", {
      pullbackTriggered,
      prevStoch,
      stochastic,
      trendMemory: state.memory.trend.length
    });

    if (pullbackTriggered && state.memory.trend.length >= 5) {
      state.scores.trend = computeTrendScore(state.memory.trend);

      console.log("[TREND → SETUP]", {
        trendScore: state.scores.trend
      });

      state.memory.trend = decay(state.memory.trend);
      state.phase = "SETUP";

      return { action: null };
    }
  }

  // ==============================
  // SETUP
  // ==============================
  else if (state.phase === "SETUP") {
    console.log("[PHASE] SETUP", { signal: state.signal });

    state.memory.setup.push({ stochastic, rsi });
    trim(state.memory.setup);

    console.log("[SETUP]", {
      setupMemory: state.memory.setup.length
    });

    if (state.memory.setup.length < 5) {
      console.log("[SETUP] Waiting for structure...");
      return { action: null };
    }

    const recoveryTriggered =
      prevStoch !== null &&
      (
        (state.signal === "BUY" && prevStoch <= 30 && stochastic > 30) ||
        (state.signal === "SELL" && prevStoch >= 70 && stochastic < 70)
      );

    console.log("[SETUP]", {
      recoveryTriggered,
      prevStoch,
      stochastic
    });

    if (recoveryTriggered) {
      state.scores.setup = computeSetupScore(
        state.memory.setup,
        state.signal
      );

      console.log("[SETUP → SCORING]", {
        setupScore: state.scores.setup
      });

      state.memory.setup = decay(state.memory.setup);
      state.phase = "SCORING";

      return { action: null };
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

    console.log("[MOMENTUM]", {
      size: state.memory.momentum.length,
      last: state.memory.momentum[state.memory.momentum.length - 1]
    });
  }

  // ==============================
  // SCORING
  // ==============================
  else if (state.phase === "SCORING") {
    console.log("[PHASE] SCORING");

    state.scores.momentum = computeMomentumScore(
      state.memory.momentum,
      state.signal
    );

    const finalScore =
      state.scores.trend +
      state.scores.setup +
      state.scores.momentum;

    console.log("[SCORING]", {
      finalScore,
      breakdown: state.scores
    });

    if (finalScore >= CONFIG.THRESHOLD) {
      console.log("[ENTRY]", {
        signal: state.signal,
        score: finalScore
      });

      const result = {
        action: "ENTER",
        signal: state.signal,
        score: finalScore
      };

      reset();
      return result;
    }else{

      console.log("[SCORING] Score below threshold", {
        finalScore,
        breakdown: state.scores,
        threshold: CONFIG.THRESHOLD
      });
      reset();
      return { action: null };
    }
  }

  return { action: null };
}


module.exports = { strategyEngine };