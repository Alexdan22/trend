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

  bestScore: 0,

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

  state.bestScore = 0;

  state.scoringStartTime = null;
}

// ==============================
// SCORING FUNCTIONS (UNCHANGED CORE)
// ==============================

function computeTrendScore(memory, context) {
  if (!memory.length) return 0;

  const {
    ema50,
    ema200,
    price,
    m15Trend, // "BUY" or "SELL"
    signal
  } = context;

  const latest = memory[memory.length - 1];

  // ==============================
  // 1. EMA ALIGNMENT (0–10)
  // ==============================
  let alignmentScore = 0;

  if (signal === "BUY") {
    if (price > ema50 && ema50 > ema200) alignmentScore = 10;
    else if (price > ema50) alignmentScore = 6;
    else alignmentScore = 2;
  } else {
    if (price < ema50 && ema50 < ema200) alignmentScore = 10;
    else if (price < ema50) alignmentScore = 6;
    else alignmentScore = 2;
  }

  // ==============================
  // 2. EMA SLOPE (0–10)
  // ==============================
  let slopeScore = 0;

  if (memory.length >= 2) {
    const prev = memory[memory.length - 2];

    const slope = latest.emaDiff - prev.emaDiff;

    // normalize slope
    if (slope > 0.0005) slopeScore = 10;
    else if (slope > 0.0002) slopeScore = 7;
    else if (slope > 0) slopeScore = 5;
    else slopeScore = 2;
  }

  // ==============================
  // 3. HTF CONFIRMATION (0–10)
  // ==============================
  let htfScore = 0;

  if (!m15Trend) {
    htfScore = 5; // neutral fallback
  } else if (m15Trend === signal) {
    htfScore = 10;
  } else {
    htfScore = 2;
  }

  // ==============================
  // 4. VOLATILITY (0–10)
  // ==============================
  let volatilityScore = 0;

  const avgWidth =
    memory.reduce((sum, m) => sum + (m.bbWidth || 0), 0) / memory.length;

  if (avgWidth > 0.002) volatilityScore = 10;
  else if (avgWidth > 0.001) volatilityScore = 7;
  else if (avgWidth > 0.0005) volatilityScore = 5;
  else volatilityScore = 2;

  // ==============================
  // FINAL SCORE
  // ==============================
  const total =
    alignmentScore +
    slopeScore +
    htfScore +
    volatilityScore;

  console.log("[TREND SCORE]", {
    alignmentScore,
    slopeScore,
    htfScore,
    volatilityScore,
    total
  });

  return total;
}

function computeSetupScore(memory, context) {
  const { signal, price, ema50, atr } = context;

  if (!memory.length) return 0;

  // ==============================
  // LOCATION
  // ==============================
  const distance = Math.abs(price - ema50);
  const normalized = distance / (atr || 1);

  let locationScore = 0;
  if (normalized < 0.2) locationScore = 2;
  else if (normalized < 0.5) locationScore = 6;
  else if (normalized < 1.2) locationScore = 10;
  else locationScore = 4;

  // ==============================
  // BEHAVIOR
  // ==============================
  const opposingMoves = memory.filter(c =>
    signal === "BUY" ? c.delta < 0 : c.delta > 0
  );

  const avgPullbackStrength =
    opposingMoves.reduce((sum, c) => sum + Math.abs(c.delta), 0) /
    (opposingMoves.length || 1);

  const avgTrendStrength =
    memory.reduce((sum, c) => sum + Math.abs(c.delta), 0) /
    memory.length;

  let behaviorScore = 0;
  if (avgPullbackStrength < avgTrendStrength * 0.6) behaviorScore = 10;
  else if (avgPullbackStrength < avgTrendStrength) behaviorScore = 6;
  else behaviorScore = 2;

  // ==============================
  // CONFIRMATION
  // ==============================
  const last = memory.at(-1);
  const prev = memory.at(-2);

  const avgDelta =
    memory.reduce((sum, c) => sum + Math.abs(c.delta), 0) /
    memory.length;

  let confirmationScore = 0;

  const strongMove =
    Math.abs(last.delta) > avgDelta * 1.2;

  if (signal === "BUY") {
    if (last.delta > 0 && prev.delta <= 0 && strongMove) confirmationScore = 10;
    else if (last.delta > 0) confirmationScore = 6;
    else confirmationScore = 2;
  } else {
    if (last.delta < 0 && prev.delta >= 0 && strongMove) confirmationScore = 10;
    else if (last.delta < 0) confirmationScore = 6;
    else confirmationScore = 2;
  }

  const total = locationScore + behaviorScore + confirmationScore;

  console.log("[SETUP SCORE]", {
    locationScore,
    behaviorScore,
    confirmationScore,
    total
  });

  return total;
}

function computeMomentumScore(memory, context) {
  const { signal, atr } = context;

  if (memory.length < 3) return 0;

  const deltas = memory.map(m => m.delta);

  // ==============================
  // 1. DIRECTIONAL STRENGTH (0–15)
  // ==============================
  const directionalMoves = deltas.filter(d =>
    signal === "BUY" ? d > 0 : d < 0
  );

  const directionalRatio = directionalMoves.length / deltas.length;

  let directionScore = 0;
  if (directionalRatio > 0.8) directionScore = 15;
  else if (directionalRatio > 0.6) directionScore = 10;
  else if (directionalRatio > 0.5) directionScore = 6;
  else directionScore = 2;

  // ==============================
  // 2. ACCELERATION (0–15)
  // ==============================
  const avgDelta =
    deltas.reduce((sum, d) => sum + Math.abs(d), 0) / deltas.length;

  const last = Math.abs(deltas.at(-1));
  const prev = Math.abs(deltas.at(-2));

  let accelScore = 0;

  if (last > prev && last > avgDelta * 1.2) accelScore = 15;
  else if (last > avgDelta) accelScore = 10;
  else if (last > avgDelta * 0.7) accelScore = 6;
  else accelScore = 2;

  // ==============================
  // 3. CONSISTENCY (0–10)
  // ==============================
  const variance =
    deltas.reduce((sum, d) => sum + Math.pow(d - avgDelta, 2), 0) /
    deltas.length;

  let consistencyScore = 0;

  if (variance < atr * 0.2) consistencyScore = 10;
  else if (variance < atr * 0.5) consistencyScore = 6;
  else consistencyScore = 2;

  const total = directionScore + accelScore + consistencyScore;

  console.log("[MOMENTUM SCORE]", {
    directionScore,
    accelScore,
    consistencyScore,
    total
  });

  return total;
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

  
  console.log("[TICK]", {
    phase: state.phase,
  signal: state.signal,
  price,
  ema50,
  ema200,
  rsi,
  stochastic,
  atr,
  mem: {
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

  if (atr && atr < 1.5) {
    console.log("[BLOCK] ATR too low", atr);
    return { action: null };
  }

  // ==============================
  // IDLE → TREND
  // ==============================
  if (state.phase === "IDLE") {

    if (ema50 > ema200) {
      state.phase = "TREND";
      state.signal = "BUY";
      console.log("[Phase] IDLE → TREND (BUY)");
    }

    if (ema50 < ema200) {
      state.phase = "TREND";
      state.signal = "SELL";
      console.log("[Phase] IDLE → TREND (SELL)");
    }

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

    console.log("[TREND]", {
      signal: state.signal,
      emaDiff: Math.abs(ema50 - ema200),
      priceDistance: Math.abs(price - ema50),
      bbWidth: bollinger.width,
      stochastic,
      memory: state.memory.trend.length
    });

    trim(state.memory.trend);

    // Trend invalidation
    if (
      (state.signal === "BUY" && ema50 < ema200) ||
      (state.signal === "SELL" && ema50 > ema200)
    ) {
      reset();
      console.log("[TREND] Invalidated, returning to IDLE");
      return { action: null };
    }

    console.log("[TREND CHECK]", {
      condition:
        (state.signal === "BUY" && stochastic < 35) ||
        (state.signal === "SELL" && stochastic > 65),
      stochastic
    });

    const pullbackTriggered =
      (state.signal === "BUY" && stochastic < 35) ||
      (state.signal === "SELL" && stochastic > 65);

    if (pullbackTriggered && state.memory.trend.length >= 3) {

      state.lockedScores.trend = computeTrendScore(state.memory.trend, {
        ema50,
        ema200,
        price,
        m15Trend: state.m15Trend, // make sure you're storing this
        signal: state.signal
      });

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

    // ==============================
    // BUILD MEMORY (STRUCTURE DATA)
    // ==============================
    const delta = price - (state.prevPrice || price);

    state.memory.setup.push({
      price,
      ema50,
      delta
    });

    state.prevPrice = price;

    trim(state.memory.setup);

    console.log("[SETUP BUILD]", {
      price,
      delta,
      size: state.memory.setup.length
    });

    // ==============================
    // REQUIRE MIN BUILDUP
    // ==============================
    if (state.memory.setup.length < 5) {
      return { action: null };
    }

    // ==============================
    // PULLBACK DETECTION
    // ==============================
    const pullbackMoves = state.memory.setup.filter(c =>
      state.signal === "BUY"
        ? c.delta < 0
        : c.delta > 0
    );

    const pullbackCount = pullbackMoves.length;

    // adaptive threshold (important)
    const minPullback =
      state.lockedScores.trend > 30 ? 2 : 3;

    // ==============================
    // RESUMPTION DETECTION
    // ==============================
    const last = state.memory.setup.at(-1);
    const prev = state.memory.setup.at(-2);

    const avgDelta =
      state.memory.setup.reduce((sum, c) => sum + Math.abs(c.delta), 0) /
      state.memory.setup.length;

    const strongMove =
      Math.abs(last.delta) > avgDelta * 1.2;

    const resuming =
      state.signal === "BUY"
        ? (last.delta > 0 && prev.delta <= 0 && strongMove)
        : (last.delta < 0 && prev.delta >= 0 && strongMove);

    // ==============================
    // DEPTH CHECK (ATR BASED)
    // ==============================
    const maxDistance = Math.max(
      ...state.memory.setup.map(c => Math.abs(c.price - c.ema50))
    );

    const hasDepth = maxDistance > (atr * 0.5);

    // ==============================
    // FINAL SETUP VALIDATION
    // ==============================
    const isValidSetup =
      pullbackCount >= minPullback &&
      resuming &&
      hasDepth;

    console.log("[SETUP CHECK]", {
      pullbackCount,
      minPullback,
      resuming,
      hasDepth,
      valid: isValidSetup
    });

    // ==============================
    // IF VALID → SCORE
    // ==============================
    if (isValidSetup) {

      state.lockedScores.setup = computeSetupScore(
        state.memory.setup,
        {
          signal: state.signal,
          price,
          ema50,
          atr
        }
      );

      // HARD FILTER
      if (state.lockedScores.setup < 10) {
        console.log("[SETUP] Rejected after scoring", state.lockedScores.setup);
        reset();
        return { action: null };
      }

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
  const delta = price - (state.prevPrice || price);

  state.memory.momentum.push({
    delta
  });

  state.prevPrice = price;

  trim(state.memory.momentum);

  state.liveScore.momentum = computeMomentumScore(
    state.memory.momentum,
    {
      signal: state.signal,
      atr
    }
  );

  const finalScore =
    state.lockedScores.trend +
    state.lockedScores.setup +
    state.liveScore.momentum;

    state.bestScore = Math.max(state.bestScore, finalScore);

  console.log("[SCORING DETAIL]", {
    trend: state.lockedScores.trend,
    setup: state.lockedScores.setup,
    momentum: state.liveScore.momentum,
    finalScore,
    bestScore: state.bestScore,
    threshold: CONFIG.THRESHOLD,
    delta: state.memory.momentum.at(-1)?.delta,
    rsi
  });

  console.log("[ENTRY CHECK]", {
    finalScore,
    threshold: CONFIG.THRESHOLD,
    decision: state.bestScore >= CONFIG.THRESHOLD
  });

  // ENTRY
  if (state.bestScore >= CONFIG.THRESHOLD) {
    const result = {
      action: "ENTER",
      signal: state.signal,
      score: state.bestScore
    };

    reset();
    console.log("[SCORING] Final Score:", state.bestScore.toFixed(2));
    return result;
  }

  // TIMEOUT EXIT
  if (Date.now() - state.scoringStartTime > CONFIG.SCORING_TIMEOUT) {
    reset();
    console.log("[RESET] Reason: SCORING TIMEOUT");
    return { action: null };
  }

  // MOMENTUM COLLAPSE
  if (state.liveScore.momentum < 3) {
    reset();
    console.log("[RESET] Reason: MOMENTUM COLLAPSE", {
      momentum: state.liveScore.momentum
    });
    return { action: null };
  }
}

  return { action: null };
}

module.exports = { strategyEngine };