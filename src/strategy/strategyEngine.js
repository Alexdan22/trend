const CONFIG = {
  THRESHOLD: 60,          // ↓ lowered from 75
  MEMORY_LIMIT: 15,       // ↓ more reactive
  DECAY: 0.8,
  SCORING_TIMEOUT: 15 * 60 * 1000 // 15 min
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

  priceHistory: [],
  
  trendPriceHistory: [],

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

function decayWeights(arr) {
  return arr.map(item => ({
    ...item,
    weight: (item.weight || 1) * CONFIG.DECAY
  }));
}

function computeDirectionalEfficiency(memory) {
  if (memory.length < 2) return 0;

  const deltas = memory.map(m => m.delta || 0);

  const netMovement =
    Math.abs(deltas.reduce((sum, d) => sum + d, 0));

  const totalMovement =
    deltas.reduce((sum, d) => sum + Math.abs(d), 0);

  if (totalMovement === 0) return 0;

  return netMovement / totalMovement;
}

function computeAlternationRatio(memory) {
  if (memory.length < 2) return 0;

  let alternations = 0;

  for (let i = 1; i < memory.length; i++) {

    const prev = memory[i - 1].delta;
    const curr = memory[i].delta;

    const flipped =
      (prev > 0 && curr < 0) ||
      (prev < 0 && curr > 0);

    if (flipped) alternations++;
  }

  return alternations / (memory.length - 1);
}

function computeSmoothedDelta(price, history = [], period = 4) {

  if (!history.length) return 0;

  const recent = history.slice(-period);

  const avg =
    recent.reduce((sum, p) => sum + p, 0) / recent.length;

  return price - avg;
}

function computeDirectionalBias(memory, signal) {

  if (memory.length < 3) {
    return {
      bullish: 0,
      bearish: 0,
      dominance: 0
    };
  }

  let bullish = 0;
  let bearish = 0;

  for (const item of memory) {

    if (item.delta > 0) bullish++;
    if (item.delta < 0) bearish++;
  }

  const total = bullish + bearish || 1;

  const bullishRatio = bullish / total;
  const bearishRatio = bearish / total;

  const dominance =
    signal === "BUY"
      ? bullishRatio - bearishRatio
      : bearishRatio - bullishRatio;

  return {
    bullish: bullishRatio,
    bearish: bearishRatio,
    dominance
  };
}

function analyzePullback(memory, signal) {

  if (memory.length < 4) {
    return {
      pullbackStrength: 0,
      reclaimStrength: 0,
      reclaimFailure: false
    };
  }

  const opposing = memory.filter(c =>
    signal === "BUY"
      ? c.delta < 0
      : c.delta > 0
  );

  const continuation = memory.filter(c =>
    signal === "BUY"
      ? c.delta > 0
      : c.delta < 0
  );

  const pullbackStrength =
    opposing.reduce((sum, c) => sum + Math.abs(c.delta), 0);

  const reclaimStrength =
    continuation.reduce((sum, c) => sum + Math.abs(c.delta), 0);

  const reclaimFailure =
    pullbackStrength > reclaimStrength * 1.2;

  return {
    pullbackStrength,
    reclaimStrength,
    reclaimFailure
  };
}

function analyzeImpulse(memory, signal) {

  if (memory.length < 4) {
    return {
      impulseStrength: 0,
      expansionStrength: 0,
      explosiveMove: false
    };
  }

  const alignedMoves = memory.filter(c =>
    signal === "BUY"
      ? c.delta > 0
      : c.delta < 0
  );

  const avgMove =
    memory.reduce((sum, c) => sum + Math.abs(c.delta), 0) /
    memory.length;

  const impulseStrength =
    alignedMoves.reduce((sum, c) => sum + Math.abs(c.delta), 0);

  const strongestMove = Math.max(
    ...alignedMoves.map(c => Math.abs(c.delta)),
    0
  );

  const expansionStrength =
    avgMove > 0
      ? strongestMove / avgMove
      : 0;

  const explosiveMove =
    expansionStrength > 2.2;

  return {
    impulseStrength,
    expansionStrength,
    explosiveMove
  };
}

function analyzeSetupAging(memory) {

  if (memory.length < 2) {
    return {
      ageMinutes: 0,
      staleStructure: false,
      decayingStructure: false
    };
  }

  const first = memory[0];
  const last = memory.at(-1);

  const ageMs =
    (last.timestamp || 0) -
    (first.timestamp || 0);

  const ageMinutes =
    ageMs / 60000;

  const recent = memory.slice(-4);

  const recentEfficiency =
    computeDirectionalEfficiency(recent);

  const staleStructure =
    ageMinutes > 8;

  const decayingStructure =
    recentEfficiency < 0.25;

  return {
    ageMinutes,
    staleStructure,
    decayingStructure
  };
}

function analyzeTrendStructure(memory, signal) {

  if (memory.length < 4) {
    return {
      persistence: 0,
      trendStrength: 0,
      strongTrend: false
    };
  }

  const aligned = memory.filter(c =>
    signal === "BUY"
      ? c.delta > 0
      : c.delta < 0
  );

  const persistence =
    aligned.length / memory.length;

  const trendStrength =
    aligned.reduce((sum, c) =>
      sum + Math.abs(c.delta), 0
    );

  const avgStrength =
    memory.reduce((sum, c) =>
      sum + Math.abs(c.delta), 0
    ) / memory.length;

  const strongTrend =
    persistence > 0.7 &&
    avgStrength > 0;

  return {
    persistence,
    trendStrength,
    strongTrend
  };
}

function analyzeMarketRegime(memory, atr) {

  if (memory.length < 4) {
    return {
      volatilityFactor: 1,
      explosiveRegime: false,
      slowRegime: false
    };
  }

  const avgDelta =
    memory.reduce((sum, c) =>
      sum + Math.abs(c.delta), 0
    ) / memory.length;

  const volatilityFactor =
    atr > 0
      ? avgDelta / atr
      : 1;

  const explosiveRegime =
    volatilityFactor > 1.2;

  const slowRegime =
    volatilityFactor < 0.5;

  return {
    volatilityFactor,
    explosiveRegime,
    slowRegime
  };
}

function analyzeMomentumProgression(memory, signal) {

  if (memory.length < 5) {
    return {
      acceleration: 0,
      persistence: 0,
      fadingMomentum: false,
      strengtheningMomentum: false
    };
  }

  const aligned = memory.map(c =>
    signal === "BUY"
      ? c.delta
      : -c.delta
  );

  const recent = aligned.slice(-3);

  const acceleration =
    recent[2] - recent[0];

  let persistenceCount = 0;

  for (const move of recent) {
    if (move > 0) persistenceCount++;
  }

  const persistence =
    persistenceCount / recent.length;

  const fadingMomentum =
    recent[2] < recent[1] &&
    recent[1] < recent[0];

  const strengtheningMomentum =
    recent[2] > recent[1] &&
    recent[1] > recent[0];

  return {
    acceleration,
    persistence,
    fadingMomentum,
    strengtheningMomentum
  };
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

  state.priceHistory = [];

  state.trendPriceHistory = [];

  state.bestScore = 0;

  state.scoringStartTime = null;
}

// ==============================
// TELEGRAM PHASE ALERTS
// ==============================

const phaseAlertState = {
  lastAlert: {}
};

const PHASE_ALERT_COOLDOWN = 30 * 1000;

async function sendPhaseAlert({
  symbol = "XAUUSD",
  from,
  to,
  signal,
  price,
  scores = {},
  extra = {}
}) {

  try {

    const now = Date.now();
    const key = `${symbol}_${to}`;

    // Anti-spam cooldown
    if (
      phaseAlertState.lastAlert[key] &&
      now - phaseAlertState.lastAlert[key] < PHASE_ALERT_COOLDOWN
    ) {
      return;
    }

    phaseAlertState.lastAlert[key] = now;

    const emojiMap = {
      IDLE: "⚪",
      TREND: "🔵",
      SETUP: "🟡",
      SCORING: "🟣",
      ENTRY: "🟢",
      INVALIDATED: "🔴"
    };

    const msg = `
${emojiMap[to] || "⚪"} STRATEGY PHASE CHANGE

Pair: ${symbol}

${from} ➜ ${to}

Signal: ${signal || "N/A"}
Price: ${price || "N/A"}

Trend Score: ${scores.trend ?? "-"}
Setup Score: ${scores.setup ?? "-"}
Momentum Score: ${scores.momentum ?? "-"}
Final Score: ${scores.final ?? "-"}

${extra.reason ? `Reason: ${extra.reason}` : ""}
${extra.details ? `Details: ${extra.details}` : ""}
`;

    console.log("[PHASE ALERT]", msg);

    // ==========================
    // TELEGRAM SEND
    // ==========================

    if (global.sendTelegram) {
      
      setImmediate(() => {

        global.sendTelegram(msg, {
          parse_mode: 'MarkdownV2'
        });

      });
    }

  } catch (err) {
    console.log("[PHASE ALERT ERROR]", err.message);
  }
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
  const avgWidth =
    memory.reduce((sum, m) => sum + (m.bbWidth || 0), 0) / memory.length;

  const efficiency =
    computeDirectionalEfficiency(memory);

  const alternation =
    computeAlternationRatio(memory);

  const trendStructure =
    analyzeTrendStructure(
      memory,
      signal
    );  

  let compressionPenalty = 0;

  // Heavy chop
  if (efficiency < 0.25 && alternation > 0.6) {
    compressionPenalty = 10;
  }

  // Moderate chop
  else if (efficiency < 0.4 && alternation > 0.45) {
    compressionPenalty = 6;
  }

  // Mild chop
  else if (efficiency < 0.55 && alternation > 0.35) {
    compressionPenalty = 3;
  }

  // ==============================
  // 1. EMA ALIGNMENT (0–10)
  // ==============================
  let alignmentScore = 0;

  if (signal === "BUY") {
    if (ema50 > ema200) {
      if (price > ema50) alignmentScore = 10;
      else alignmentScore = 7;
    } else {
      alignmentScore = 2;
    }
  } else {
    if (ema50 < ema200) {
      if (price < ema50) alignmentScore = 10;
      else alignmentScore = 7;
    } else {
      alignmentScore = 2;
    }
  }

  // ==============================
  // 2. EMA SLOPE (0–10)
  // ==============================
  let slopeScore = 0;

  if (memory.length >= 2) {
    const prev = memory[memory.length - 2];

    const slope = latest.emaDiff - prev.emaDiff;
    const normalizedSlope = slope / (context.atr || 1);

    if (normalizedSlope > 0.2) slopeScore = 10;
    else if (normalizedSlope > 0.1) slopeScore = 7;
    else if (normalizedSlope > 0) slopeScore = 5;
    else slopeScore = 2;
  }

  // ==============================
  // 3. HTF CONFIRMATION (0–10)
  // ==============================
  let htfScore = 0;
  console.log("[HTF]", state.m15Trend);

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

  const normalizedWidth = avgWidth / (context.atr || 1);

  if (normalizedWidth > 1.5) volatilityScore = 10;
  else if (normalizedWidth > 1.0) volatilityScore = 7;
  else if (normalizedWidth > 0.5) volatilityScore = 5;
  else volatilityScore = 2;

  // ==============================
  // 5. PERSISTENCE (0–10)
  // ==============================
  let persistenceScore = 0;

  if (trendStructure.persistence > 0.8) {
    persistenceScore = 10;
  }
  else if (trendStructure.persistence > 0.65) {
    persistenceScore = 7;
  }
  else if (trendStructure.persistence > 0.5) {
    persistenceScore = 5;
  }
  else {
    persistenceScore = 2;
  }

  // ==============================
  // 6. EXPANSION BONUS
  // ==============================
  let expansionBonus = 0;

  if (trendStructure.strongTrend) {
    expansionBonus = 5;
  }

  // ==============================
  // FINAL SCORE
  // ==============================
  const rawTotal =
    alignmentScore +
    slopeScore +
    htfScore +
    volatilityScore +
    persistenceScore +
    expansionBonus;

  const total = Math.max(
    0,
    rawTotal - compressionPenalty
  );
  

  console.log("[TREND SCORE]", {
    alignmentScore,
    slopeScore,
    htfScore,
    volatilityScore,

    efficiency: efficiency.toFixed(2),
    alternation: alternation.toFixed(2),
    persistence:
      trendStructure.persistence.toFixed(2),

    trendStrength:
      trendStructure.trendStrength.toFixed(2),

    strongTrend:
      trendStructure.strongTrend,

    persistenceScore,
    expansionBonus,

    compressionPenalty,

    rawTotal,
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

  const maxPullbackStrength = Math.max(
    ...opposingMoves.map(c => Math.abs(c.delta)),
    0
  );

  const avgTrendStrength =
    memory.reduce((sum, c) => sum + Math.abs(c.delta), 0) /
    memory.length;

  let behaviorScore = 0;
  if (maxPullbackStrength < avgTrendStrength * 0.6) behaviorScore = 10;
  else if (maxPullbackStrength < avgTrendStrength) behaviorScore = 6;
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
    Math.abs(last.delta) > avgDelta * 1.0;

  if (signal === "BUY") {
    if (last.delta > 0 && prev.delta <= 0 && strongMove) confirmationScore = 10;
    else if (last.delta > 0) confirmationScore = 6;
    else confirmationScore = 2;
  } else {
    if (last.delta < 0 && prev.delta >= 0 && strongMove) confirmationScore = 10;
    else if (last.delta < 0) confirmationScore = 6;
    else confirmationScore = 2;
  }
  
  let structureBonus = 0;

  if (opposingMoves.length >= 2 && confirmationScore >= 6) {
    structureBonus = 3;
  }

  const total = locationScore + behaviorScore + confirmationScore + structureBonus;

  console.log("[SETUP SCORE]", {
    locationScore,
    behaviorScore,
    confirmationScore,
    structureBonus, 
    total
  });

  return total;
}

function computeMomentumScore(memory, context) {
  const { signal, atr } = context;

  if (memory.length < 4) return 0;

  const deltas = memory.map(m => m.delta);
  const absDeltas = deltas.map(d => Math.abs(d));

  const last = deltas.at(-1);
  const prev = deltas.at(-2);
  const prev2 = deltas.at(-3);

  const avg = absDeltas.reduce((a, b) => a + b, 0) / absDeltas.length;

  const progression =
    analyzeMomentumProgression(
      memory,
      signal
    );

  // ==============================
  // 1. PULLBACK CONTEXT (0–10)
  // ==============================
  const oppositeMoves = deltas.filter(d =>
    signal === "BUY" ? d < 0 : d > 0
  );

  const pullbackRatio = oppositeMoves.length / deltas.length;

  let pullbackScore = 0;

  if (pullbackRatio > 0.6) pullbackScore = 10;     // strong pullback
  else if (pullbackRatio > 0.4) pullbackScore = 7; // moderate
  else pullbackScore = 3;                          // weak / already trend

  // ==============================
  // 2. EXHAUSTION (0–15) ⭐ KEY
  // ==============================
  const weakening =
    Math.abs(last) < Math.abs(prev) &&
    Math.abs(prev) < Math.abs(prev2);

  const belowAverage = Math.abs(last) < avg * 0.8;

  let exhaustionScore = 0;

  if (weakening && belowAverage) exhaustionScore = 15;
  else if (weakening) exhaustionScore = 10;
  else if (belowAverage) exhaustionScore = 6;
  else exhaustionScore = 2;

  // ==============================
  // 3. REVERSAL TRIGGER (0–15)
  // ==============================
  let reversalScore = 0;

  const flipsDirection =
    signal === "BUY"
      ? (last > 0 && prev <= 0)
      : (last < 0 && prev >= 0);

  const strongFlip = Math.abs(last) > avg * 0.8;

  if (flipsDirection && strongFlip) reversalScore = 15;
  else if (flipsDirection) reversalScore = 10;
  else if (
    (signal === "BUY" && last > 0) ||
    (signal === "SELL" && last < 0)
  ) reversalScore = 6;
  else reversalScore = 2;

  // ==============================
  // 4. NOISE FILTER (0–10)
  // ==============================
  const variance =
    absDeltas.reduce((sum, d) => sum + Math.pow(d - avg, 2), 0) /
    absDeltas.length;

  let noiseScore = 0;

  if (variance < (atr || 1) * 0.2) noiseScore = 10;
  else if (variance < (atr || 1) * 0.5) noiseScore = 6;
  else noiseScore = 3;

  // ==============================
  // 5. MOMENTUM PROGRESSION (0–15)
  // ==============================
  let progressionScore = 0;

  if (
    progression.strengtheningMomentum &&
    progression.persistence >= 0.66
  ) {
    progressionScore = 15;
  }
  else if (
    progression.strengtheningMomentum
  ) {
    progressionScore = 10;
  }
  else if (
    progression.fadingMomentum
  ) {
    progressionScore = 2;
  }
  else {
    progressionScore = 6;
  }

  // ==============================
  // 6. ACCELERATION BONUS
  // ==============================
  let accelerationBonus = 0;

  if (progression.acceleration > avg * 0.5) {
    accelerationBonus = 5;
  }
  else if (progression.acceleration < -avg * 0.5) {
    accelerationBonus = -3;
  }

  // ==============================
  // FINAL SCORE
  // ==============================
  const total =
    pullbackScore +
    exhaustionScore +
    reversalScore +
    noiseScore +
    progressionScore +
    accelerationBonus;

  console.log("[MOMENTUM V2]", {
    pullbackScore,
    exhaustionScore,
    reversalScore,
    noiseScore,
    progressionScore,
    accelerationBonus,

    acceleration:
      progression.acceleration.toFixed(2),

    persistence:
      progression.persistence.toFixed(2),

    fadingMomentum:
      progression.fadingMomentum,

    strengtheningMomentum:
      progression.strengtheningMomentum,
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
      const previousPhase = state.phase;

      state.phase = "TREND";
      state.signal = "BUY";

      console.log("[Phase] IDLE → TREND (BUY)");

      sendPhaseAlert({
        from: previousPhase,
        to: state.phase,
        signal: state.signal,
        price,
        scores: {},
        extra: {
          reason: "EMA50 crossed above EMA200"
        }
      });
    }

    if (ema50 < ema200) {
      const previousPhase = state.phase;

      state.phase = "TREND";
      state.signal = "SELL";

      console.log("[Phase] IDLE → TREND (SELL)");

      sendPhaseAlert({
        from: previousPhase,
        to: state.phase,
        signal: state.signal,
        price,
        scores: {},
        extra: {
          reason: "EMA50 crossed below EMA200"
        }
      });
    }

    return { action: null };
  }

  // ==============================
  // TREND
  // ==============================
  if (state.phase === "TREND") {

    state.trendPriceHistory.push(price);

    trim(state.trendPriceHistory);

    const trendDelta = computeSmoothedDelta(
      price,
      state.trendPriceHistory,
      5
    );


    state.memory.trend.push({
      emaDiff: Math.abs(ema50 - ema200),
      priceDistance: Math.abs(price - ema50),
      bbWidth: bollinger.width || 0,
      delta: trendDelta
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
      sendPhaseAlert({
        from: state.phase,
        to: "INVALIDATED",
        signal: state.signal,
        price,
        extra: {
          reason: "Trend invalidation"
        }
      });

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

      const previousPhase = state.phase;

      state.phase = "SETUP";

      sendPhaseAlert({
        from: previousPhase,
        to: state.phase,
        signal: state.signal,
        price,
        scores: {
          trend: state.lockedScores.trend
        },
        extra: {
          reason: "Pullback detected"
        }
      });
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
    state.priceHistory.push(price);

    trim(state.priceHistory);

    const delta = computeSmoothedDelta(
      price,
      state.priceHistory,
      4
    );

    state.memory.setup.push({
      price,
      ema50,
      delta,
      weight: 1,
      timestamp: Date.now()
    });


    trim(state.memory.setup);

    const efficiency =
      computeDirectionalEfficiency(state.memory.setup);

    const alternation =
      computeAlternationRatio(state.memory.setup);

    const heavyChop =
      efficiency < 0.25 &&
      alternation > 0.65;

    const moderateChop =
      efficiency < 0.40 &&
      alternation > 0.50;  

    const directionBias =
      computeDirectionalBias(
        state.memory.setup,
        state.signal
      );  

    const weakStructure =
      directionBias.dominance < 0.15;

    const failedStructure =
      directionBias.dominance < 0;  

    const pullbackAnalysis =
      analyzePullback(
        state.memory.setup,
        state.signal
      );  

    const regimeAnalysis =
      analyzeMarketRegime(
        state.memory.setup,
        atr
      );  

    const dangerousPullback =
      regimeAnalysis?.explosiveRegime
        ? pullbackAnalysis.pullbackStrength >
          pullbackAnalysis.reclaimStrength * 1.5
        : pullbackAnalysis.reclaimFailure;
    
    const impulseAnalysis =
      analyzeImpulse(
        state.memory.setup,
        state.signal
      );  

    const impulseWeak =
      impulseAnalysis.expansionStrength < 1.2;
  
    const explosiveImpulse =
      impulseAnalysis.explosiveMove;

    const agingAnalysis =
      analyzeSetupAging(
        state.memory.setup
      );  

    const staleSetup =
      agingAnalysis.staleStructure;

    const decayingSetup =
      agingAnalysis.decayingStructure;  

      
    console.log("[MARKET STRUCTURE]", {
      efficiency: efficiency.toFixed(2),
      alternation: alternation.toFixed(2)
    });

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
    // CHOP INVALIDATION
    // ==============================
    if (heavyChop) {

      console.log("[SETUP INVALIDATED] Heavy chop detected", {
        efficiency: efficiency.toFixed(2),
        alternation: alternation.toFixed(2)
      });

      sendPhaseAlert({
        from: state.phase,
        to: "INVALIDATED",
        signal: state.signal,
        price,
        extra: {
          reason: "Heavy chop detected"
        }
      });

      reset();

      return { action: null };
    }

    // ==============================
    // STRUCTURE FAILURE
    // ==============================
    if (failedStructure) {

      console.log("[SETUP INVALIDATED] Structure failure", {
        bullish: directionBias.bullish.toFixed(2),
        bearish: directionBias.bearish.toFixed(2),
        dominance: directionBias.dominance.toFixed(2)
      });

      sendPhaseAlert({
        from: state.phase,
        to: "INVALIDATED",
        signal: state.signal,
        price,
        extra: {
          reason: "Structure failure detected"
        }
      });

      reset();

      return { action: null };
    }

    // ==============================
    // DANGEROUS PULLBACK
    // ==============================
    if (dangerousPullback) {

      console.log("[SETUP INVALIDATED] Dangerous pullback", {
        pullbackStrength:
          pullbackAnalysis.pullbackStrength.toFixed(2),

        reclaimStrength:
          pullbackAnalysis.reclaimStrength.toFixed(2)
      });

      sendPhaseAlert({
        from: state.phase,
        to: "INVALIDATED",
        signal: state.signal,
        price,
        extra: {
          reason: "Dangerous pullback detected"
        }
      });

      reset();

      return { action: null };
    }

    // ==============================
    // STALE / DECAYING SETUP
    // ==============================
    if (staleSetup && decayingSetup) {

      console.log("[SETUP INVALIDATED] Stale structure", {
        ageMinutes:
          agingAnalysis.ageMinutes.toFixed(2)
      });

      sendPhaseAlert({
        from: state.phase,
        to: "INVALIDATED",
        signal: state.signal,
        price,
        extra: {
          reason: "Stale decaying setup"
        }
      });

      reset();

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
    let minPullback =
      state.lockedScores.trend > 30 ? 2 : 3;

    // Require stronger structure during chop
    if (moderateChop) {
      minPullback += 2;
    }

    if (weakStructure) {
      minPullback += 2;
    }

    if (impulseWeak) {
      minPullback += 1;
    }

    if (staleSetup) {
      minPullback += 1;
    }

    if (decayingSetup) {
      minPullback += 2;
    }

    // Explosive markets can tolerate
    // slightly messier pullbacks
    if (regimeAnalysis.explosiveRegime) {
      minPullback -= 1;
    }

    // Slow markets require
    // stronger confirmation
    if (regimeAnalysis.slowRegime) {
      minPullback += 1;
    }

    

    // ==============================
    // RESUMPTION DETECTION
    // ==============================
    const last = state.memory.setup.at(-1);
    const prev = state.memory.setup.at(-2);

    const avgDelta =
      state.memory.setup.reduce((sum, c) => sum + Math.abs(c.delta), 0) /
      state.memory.setup.length;

    const strongMove =
      Math.abs(last.delta) > avgDelta * 1.0;

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

    const hasDepth = maxDistance > (atr * 0.4);

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
      efficiency: efficiency.toFixed(2),
      alternation: alternation.toFixed(2),
      bullishBias: directionBias.bullish.toFixed(2),
      bearishBias: directionBias.bearish.toFixed(2),
      dominance: directionBias.dominance.toFixed(2),
      pullbackStrength:
      pullbackAnalysis.pullbackStrength.toFixed(2),
      impulseStrength:
        impulseAnalysis.impulseStrength.toFixed(2),

      expansionStrength:
        impulseAnalysis.expansionStrength.toFixed(2),

      impulseWeak,
      explosiveImpulse,
      ageMinutes:
      agingAnalysis.ageMinutes.toFixed(2),

      staleSetup,
      decayingSetup,
      volatilityFactor:
        regimeAnalysis.volatilityFactor.toFixed(2),

      explosiveRegime:
        regimeAnalysis.explosiveRegime,

      slowRegime:
        regimeAnalysis.slowRegime,

      reclaimStrength:
        pullbackAnalysis.reclaimStrength.toFixed(2),

      dangerousPullback,

      weakStructure,
      failedStructure,
      heavyChop,
      moderateChop,
      valid: isValidSetup
    });

    // ==============================
    // IF VALID → SCORE
    // ==============================
    if (isValidSetup) {

      let impulseBonus = 0;

      if (explosiveImpulse) {
        impulseBonus = 5;

        console.log("[IMPULSE BONUS]", {
          expansionStrength:
            impulseAnalysis.expansionStrength.toFixed(2),

          bonus: impulseBonus
        });
      }

      state.lockedScores.setup =
        computeSetupScore(
          state.memory.setup,
          {
            signal: state.signal,
            price,
            ema50,
            atr
          }
        ) + impulseBonus;

      // HARD FILTER
      if (state.lockedScores.setup < 10) {
        console.log("[SETUP] Rejected after scoring", state.lockedScores.setup);
        reset();
        return { action: null };
      }

      state.memory.setup = decayWeights(state.memory.setup);
      const previousPhase = state.phase;
      state.phase = "SCORING";
      state.scoringStartTime = Date.now();

      console.log("[SETUP] Locked Setup Score:", state.lockedScores.setup.toFixed(2));
      console.log("[Phase] → SCORING");

      sendPhaseAlert({
        from: previousPhase,
        to: state.phase,
        signal: state.signal,
        price,
        scores: {
          trend: state.lockedScores.trend,
          setup: state.lockedScores.setup
        },
        extra: {
          reason: "Valid setup confirmed"
        }
      });

      return { action: null };
    }
  }

  // ==============================
  // SCORING 
  // ==============================
  if (state.phase === "SCORING") {

    // Collect momentum
    state.priceHistory.push(price);

    trim(state.priceHistory);

    const delta = computeSmoothedDelta(
      price,
      state.priceHistory,
      4
    );

    state.memory.momentum.push({
      delta,
      weight: 1
    });

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

      sendPhaseAlert({
        from: "SCORING",
        to: "ENTRY",
        signal: state.signal,
        price,
        scores: {
          trend: state.lockedScores.trend,
          setup: state.lockedScores.setup,
          momentum: state.liveScore.momentum,
          final: state.bestScore
        },
        extra: {
          reason: "Threshold reached"
        }
      });

      reset();
      console.log("[SCORING] Final Score:", state.bestScore.toFixed(2));
      return result;
    }

    // TIMEOUT EXIT
    if (Date.now() - state.scoringStartTime > CONFIG.SCORING_TIMEOUT) {
      sendPhaseAlert({
        from: state.phase,
        to: "IDLE",
        signal: state.signal,
        price,
        scores: {
          trend: state.lockedScores.trend,
          setup: state.lockedScores.setup,
          momentum: state.liveScore.momentum,
          final: state.bestScore
        },
        extra: {
          reason: "SCORING TIMEOUT"
        }
      });

      reset();

      console.log("[RESET] Reason: SCORING TIMEOUT");
      return { action: null };
    }
  }

  return { action: null };
}

module.exports = { strategyEngine };