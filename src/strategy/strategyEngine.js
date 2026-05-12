const CONFIG = {
  THRESHOLD: 60,          // ↓ lowered from 75
  MEMORY_LIMIT: 15,       // ↓ more reactive
  DECAY: 0.8,
  SWING_MEMORY_LIMIT: 30,
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

  validation: {
    healthyStructure: false,
    continuationConfidence: 0,
    contradictionRisk: 0,
    reclaimQuality: 0,

    constructiveCompression: false,
    compressionQuality: 0,
    compressionBias: 0,

    dynamicDecayRisk: 0,

    expansionReadiness: 0,
    expansionPressure: 0,
    expansionBias: "NEUTRAL",

    expansionTriggerActive: false,
    expansionTriggerStrength: 0,
    displacementDetected: false,
    volatilityReleaseDetected: false,
    accelerationDetected: false,

    behavioralValidation: false,
    behavioralConfidence: 0,
    behavioralEntryEligible: false
  },

  swingStructure: {
    highs: [],
    lows: [],
    lastHigh: null,
    lastLow: null,

    marketStructure: "UNKNOWN",

    higherHighs: 0,
    higherLows: 0,

    lowerHighs: 0,
    lowerLows: 0,

    bullishBOS: false,
    bearishBOS: false,

    structureBreakStrength: 0,

    lastBreakDirection: null
  },

  bestScore: 0,

  priceHistory: [],
  
  trendPriceHistory: [],

  scoringStartTime: null
};

// ==============================
// HELPERS
// ==============================


function trim(arr, limit = CONFIG.MEMORY_LIMIT) {

  if (arr.length > limit) {
    arr.splice(0, arr.length - limit);
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

function analyzeDirectionalDrift(memory, signal) {

  if (memory.length < 6) {
    return {
      directionalDrift: false,
      driftStrength: 0,
      staircaseTrend: false
    };
  }

  const recent = memory.slice(-6);

  const netMove =
    Math.abs(
      recent.at(-1).price -
      recent[0].price
    );

  const avgNoise =
    recent.reduce(
      (sum, c) => sum + Math.abs(c.delta),
      0
    ) / recent.length;

  const alignedCandles =
    recent.filter(c =>
      signal === "BUY"
        ? c.delta > 0
        : c.delta < 0
    ).length;

  const directionalDrift =
    netMove > avgNoise * 2.0;

  const staircaseTrend =
    alignedCandles >= 4;

  let driftStrength = 0;

  if (directionalDrift)
    driftStrength += 60;

  if (staircaseTrend)
    driftStrength += 40;

  driftStrength =
    Math.min(100, driftStrength);

  return {
    directionalDrift,
    driftStrength,
    staircaseTrend
  };
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

function analyzeContinuationState(memory, signal) {

  if (memory.length < 10) {
    return {
      healthyStructure: false,
      continuationConfidence: 0,
      contradictionRisk: 100,
      reclaimQuality: 0,
      stabilizationStrength: 0,
      weakeningOpposition: false
    };
  }

  const recent = memory.slice(-5);
  const older = memory.slice(-10, -5);

  const efficiency =
    computeDirectionalEfficiency(recent);

  const alternation =
    computeAlternationRatio(recent);

  const bias =
    computeDirectionalBias(
      recent,
      signal
    );

  // ==============================
  // OPPOSITION ANALYSIS
  // ==============================
  const opposingRecent = recent.filter(c =>
    signal === "BUY"
      ? c.delta < 0
      : c.delta > 0
  );

  const opposingOlder = older.filter(c =>
    signal === "BUY"
      ? c.delta < 0
      : c.delta > 0
  );

  const recentOpposition =
    opposingRecent.reduce((sum, c) =>
      sum + Math.abs(c.delta), 0);

  const olderOpposition =
    opposingOlder.reduce((sum, c) =>
      sum + Math.abs(c.delta), 0);

  const weakeningOpposition =
    olderOpposition > 0
      ? recentOpposition < olderOpposition * 0.75
      : false;

  // ==============================
  // STABILIZATION ANALYSIS
  // ==============================
  let stabilizationStrength = 0;

  if (efficiency > 0.55)
    stabilizationStrength += 30;

  else if (efficiency > 0.40)
    stabilizationStrength += 15;

  if (alternation < 0.35)
    stabilizationStrength += 25;

  else if (alternation < 0.50)
    stabilizationStrength += 10;

  if (bias.dominance > 0.5)
    stabilizationStrength += 30;

  else if (bias.dominance > 0.2)
    stabilizationStrength += 15;

  if (weakeningOpposition)
    stabilizationStrength += 15;

  // ==============================
  // CONTINUATION CONFIDENCE
  // ==============================
  let continuationConfidence = 0;

  continuationConfidence += stabilizationStrength;

  // ==============================
  // HEALTHY STRUCTURE
  // ==============================
  const healthyStructure =
    efficiency > 0.35 &&
    alternation < 0.65 &&
    bias.dominance > 0;

  // ==============================
  // CONTRADICTION RISK
  // ==============================
  let contradictionRisk = 0;

  if (bias.dominance < 0)
    contradictionRisk += 50;

  if (alternation > 0.70)
    contradictionRisk += 25;

  if (efficiency < 0.20)
    contradictionRisk += 25;

  // ==============================
  // RECLAIM QUALITY
  // ==============================
  let reclaimQuality = 0;

  if (bias.dominance > 0.60)
    reclaimQuality += 35;

  else if (bias.dominance > 0.30)
    reclaimQuality += 20;

  if (weakeningOpposition)
    reclaimQuality += 20;

  if (efficiency > 0.50)
    reclaimQuality += 25;

  return {
    healthyStructure,
    continuationConfidence,
    contradictionRisk,
    reclaimQuality,
    stabilizationStrength,
    weakeningOpposition
  };
}

function analyzeCompression(memory, signal) {

  if (memory.length < 10) {
    return {
      constructiveCompression: false,
      compressionQuality: 0,
      compressionBias: 0,
      volatilityCompression: false,
      directionalCompression: false
    };
  }

  const recent = memory.slice(-4);
  const older = memory.slice(-8, -4);

  // ==============================
  // VOLATILITY COMPRESSION
  // ==============================
  const recentRange =
    recent.reduce((sum, c) =>
      sum + Math.abs(c.delta), 0);

  const olderRange =
    older.reduce((sum, c) =>
      sum + Math.abs(c.delta), 0);

  const volatilityCompression =
    recentRange < olderRange * 0.75;

  // ==============================
  // STRUCTURE QUALITY
  // ==============================
  const recentEfficiency =
    computeDirectionalEfficiency(recent);

  const recentAlternation =
    computeAlternationRatio(recent);

  // ==============================
  // DIRECTIONAL BIAS
  // ==============================
  const bias =
    computeDirectionalBias(
      recent,
      signal
    );

  const directionalCompression =
    bias.dominance > 0.20 &&
    recentAlternation < 0.55;

  // ==============================
  // COMPRESSION QUALITY
  // ==============================
  let compressionQuality = 0;

  if (volatilityCompression)
    compressionQuality += 35;

  if (recentEfficiency > 0.45)
    compressionQuality += 25;

  else if (recentEfficiency > 0.30)
    compressionQuality += 15;

  if (recentAlternation < 0.40)
    compressionQuality += 20;

  else if (recentAlternation < 0.55)
    compressionQuality += 10;

  if (bias.dominance > 0.40)
    compressionQuality += 20;

  else if (bias.dominance > 0.20)
    compressionQuality += 10;

  // ==============================
  // FINAL CLASSIFICATION
  // ==============================
  const constructiveCompression =
    volatilityCompression &&
    directionalCompression &&
    compressionQuality >= 60;

  return {
    constructiveCompression,
    compressionQuality,
    compressionBias: bias.dominance,
    volatilityCompression,
    directionalCompression
  };
}

function analyzeDynamicDecay({
  agingAnalysis,
  continuationState,
  compressionState,
  efficiency,
  alternation
}) {

  let dynamicDecayRisk = 0;

  // ==============================
  // BASE STALE PRESSURE
  // ==============================
  if (agingAnalysis.ageMinutes > 8)
    dynamicDecayRisk += 25;

  if (agingAnalysis.ageMinutes > 12)
    dynamicDecayRisk += 20;

  // ==============================
  // STRUCTURE DETERIORATION
  // ==============================
  if (efficiency < 0.25)
    dynamicDecayRisk += 20;

  if (alternation > 0.65)
    dynamicDecayRisk += 20;

  // ==============================
  // CONTRADICTION
  // ==============================
  dynamicDecayRisk +=
    continuationState.contradictionRisk * 0.5;

  // ==============================
  // POSITIVE OFFSET
  // ==============================
  if (continuationState.healthyStructure)
    dynamicDecayRisk -= 15;

  if (compressionState.constructiveCompression)
    dynamicDecayRisk -= 20;

  if (continuationState.reclaimQuality > 50)
    dynamicDecayRisk -= 15;

  // Clamp
  dynamicDecayRisk =
    Math.max(0, Math.min(100, dynamicDecayRisk));

  return {
    dynamicDecayRisk,
    decayingStructure:
      dynamicDecayRisk >= 60
  };
}

function detectSwings(memory) {

  if (memory.length < 5) {
    return {
      swingHigh: null,
      swingLow: null,
      detectedHigh: false,
      detectedLow: false
    };
  }

  const mid =
    memory[memory.length - 3];

  const left1 =
    memory[memory.length - 5];

  const left2 =
    memory[memory.length - 4];

  const right1 =
    memory[memory.length - 2];

  const right2 =
    memory[memory.length - 1];

  // ==============================
  // SWING HIGH
  // ==============================
  const detectedHigh =
    mid.price > left1.price &&
    mid.price > left2.price &&
    mid.price > right1.price &&
    mid.price > right2.price;

  // ==============================
  // SWING LOW
  // ==============================
  const detectedLow =
    mid.price < left1.price &&
    mid.price < left2.price &&
    mid.price < right1.price &&
    mid.price < right2.price;

  return {
    swingHigh:
      detectedHigh ? mid.price : null,

    swingLow:
      detectedLow ? mid.price : null,

    detectedHigh,
    detectedLow
  };
}

function classifyMarketStructure(swingStructure) {

  const highs =
    swingStructure.highs;

  const lows =
    swingStructure.lows;

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {
    return {
      marketStructure: "UNKNOWN",

      higherHighs: 0,
      higherLows: 0,

      lowerHighs: 0,
      lowerLows: 0
    };
  }

  const lastHigh =
    highs[highs.length - 1];

  const prevHigh =
    highs[highs.length - 2];

  const lastLow =
    lows[lows.length - 1];

  const prevLow =
    lows[lows.length - 2];

  const higherHighs =
    lastHigh.price > prevHigh.price ? 1 : 0;

  const lowerHighs =
    lastHigh.price < prevHigh.price ? 1 : 0;

  const higherLows =
    lastLow.price > prevLow.price ? 1 : 0;

  const lowerLows =
    lastLow.price < prevLow.price ? 1 : 0;

  let marketStructure = "RANGE";

  if (
    higherHighs &&
    higherLows
  ) {
    marketStructure = "BULLISH";
  }

  else if (
    lowerHighs &&
    lowerLows
  ) {
    marketStructure = "BEARISH";
  }

  return {
    marketStructure,

    higherHighs,
    higherLows,

    lowerHighs,
    lowerLows
  };
}

function analyzeBreakOfStructure(
  swingStructure,
  currentPrice
) {

  const highs =
    swingStructure.highs;

  const lows =
    swingStructure.lows;

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {
    return {
      bullishBOS: false,
      bearishBOS: false,
      structureBreakStrength: 0,
      lastBreakDirection: null
    };
  }

  const lastHigh =
    highs[highs.length - 1];

  const prevHigh =
    highs[highs.length - 2];

  const lastLow =
    lows[lows.length - 1];

  const prevLow =
    lows[lows.length - 2];

  // ==============================
  // BREAK CONDITIONS
  // ==============================
  const bullishBOS =
    currentPrice > lastHigh.price &&
    lastHigh.price > prevHigh.price;

  const bearishBOS =
    currentPrice < lastLow.price &&
    lastLow.price < prevLow.price;

  // ==============================
  // BREAK STRENGTH
  // ==============================
  let structureBreakStrength = 0;

  if (bullishBOS) {

    const displacement =
      currentPrice - lastHigh.price;

    const priorExpansion =
      lastHigh.price - prevHigh.price;

    structureBreakStrength =
      priorExpansion > 0
        ? displacement / priorExpansion
        : 0;
  }

  if (bearishBOS) {

    const displacement =
      lastLow.price - currentPrice;

    const priorExpansion =
      prevLow.price - lastLow.price;

    structureBreakStrength =
      priorExpansion > 0
        ? displacement / priorExpansion
        : 0;
  }

  return {
    bullishBOS,
    bearishBOS,

    structureBreakStrength,

    lastBreakDirection:
      bullishBOS
        ? "BULLISH"
        : bearishBOS
          ? "BEARISH"
          : null
  };
}

function analyzeExpansionReadiness({
  continuationState,
  compressionState,
  swingStructure,
  efficiency,
  alternation
}) {

  let expansionReadiness = 0;

  // ==============================
  // CONTINUATION QUALITY
  // ==============================
  expansionReadiness +=
    continuationState.continuationConfidence * 0.30;

  // ==============================
  // COMPRESSION QUALITY
  // ==============================
  expansionReadiness +=
    compressionState.compressionQuality * 0.25;

  // ==============================
  // STRUCTURE HEALTH
  // ==============================
  if (
    swingStructure.marketStructure === "BULLISH" ||
    swingStructure.marketStructure === "BEARISH"
  ) {
    expansionReadiness += 15;
  }

  // ==============================
  // BOS ALIGNMENT
  // ==============================
  if (
    swingStructure.bullishBOS ||
    swingStructure.bearishBOS
  ) {
    expansionReadiness += 20;
  }

  // ==============================
  // EFFICIENCY
  // ==============================
  if (efficiency > 0.50)
    expansionReadiness += 10;

  else if (efficiency > 0.35)
    expansionReadiness += 5;

  // ==============================
  // ALTERNATION PENALTY
  // ==============================
  if (alternation > 0.60)
    expansionReadiness -= 15;

  else if (alternation > 0.45)
    expansionReadiness -= 5;

  // Clamp
  expansionReadiness =
    Math.max(
      0,
      Math.min(100, expansionReadiness)
    );

  // ==============================
  // EXPANSION PRESSURE
  // ==============================
  let expansionPressure = 0;

  expansionPressure +=
    continuationState.reclaimQuality * 0.4;

  expansionPressure +=
    compressionState.compressionQuality * 0.3;

  expansionPressure +=
    swingStructure.structureBreakStrength * 20;

  expansionPressure =
    Math.max(
      0,
      Math.min(100, expansionPressure)
    );

  // ==============================
  // EXPANSION BIAS
  // ==============================
  let expansionBias = "NEUTRAL";

  if (
    swingStructure.marketStructure === "BULLISH" &&
    continuationState.healthyStructure
  ) {
    expansionBias = "BULLISH";
  }

  else if (
    swingStructure.marketStructure === "BEARISH" &&
    continuationState.healthyStructure
  ) {
    expansionBias = "BEARISH";
  }

  return {
    expansionReadiness,
    expansionPressure,
    expansionBias
  };
}

function analyzeExpansionTrigger({
  setupMemory,
  compressionState,
  swingStructure,
  impulseAnalysis,
  atr
}) {

  if (setupMemory.length < 5) {
    return {
      expansionTriggerActive: false,
      expansionTriggerStrength: 0,
      displacementDetected: false,
      volatilityReleaseDetected: false,
      accelerationDetected: false
    };
  }

  const recent =
    setupMemory.slice(-3);

  const avgDelta =
    setupMemory.reduce(
      (sum, c) => sum + Math.abs(c.delta),
      0
    ) / setupMemory.length;

  const latest =
    recent[recent.length - 1];

  const prev =
    recent[recent.length - 2];

  // ==============================
  // DISPLACEMENT
  // ==============================
  const displacementDetected =
    Math.abs(latest.delta) >
    Math.max(
      avgDelta * 1.8,
      (atr || 1) * 0.25
    );

  // ==============================
  // ACCELERATION
  // ==============================
  const acceleration =
    Math.abs(latest.delta) -
    Math.abs(prev.delta);

  const accelerationDetected =
    acceleration > avgDelta * 0.5;

  // ==============================
  // VOLATILITY RELEASE
  // ==============================
  const volatilityReleaseDetected =
    compressionState.constructiveCompression &&
    impulseAnalysis.explosiveMove;

  // ==============================
  // TRIGGER STRENGTH
  // ==============================
  let expansionTriggerStrength = 0;

  if (displacementDetected)
    expansionTriggerStrength += 35;

  if (accelerationDetected)
    expansionTriggerStrength += 25;

  if (volatilityReleaseDetected)
    expansionTriggerStrength += 25;

  if (
    swingStructure.bullishBOS ||
    swingStructure.bearishBOS
  ) {
    expansionTriggerStrength += 15;
  }

  // Clamp
  expansionTriggerStrength =
    Math.max(
      0,
      Math.min(100, expansionTriggerStrength)
    );

  // ==============================
  // FINAL TRIGGER
  // ==============================
  const expansionTriggerActive =
    expansionTriggerStrength >= 60;

  return {
    expansionTriggerActive,
    expansionTriggerStrength,
    displacementDetected,
    volatilityReleaseDetected,
    accelerationDetected
  };
}

function analyzeBehavioralValidation({
  continuationState,
  compressionState,
  swingStructure,
  validation
}) {

  let behavioralConfidence = 0;

  // ==============================
  // CONTINUATION QUALITY
  // ==============================
  if (continuationState.healthyStructure)
    behavioralConfidence += 20;

  behavioralConfidence +=
    continuationState.continuationConfidence * 0.20;

  // ==============================
  // COMPRESSION QUALITY
  // ==============================
  if (compressionState.constructiveCompression)
    behavioralConfidence += 15;

  behavioralConfidence +=
    compressionState.compressionQuality * 0.15;

  // ==============================
  // STRUCTURE ALIGNMENT
  // ==============================
  if (
    swingStructure.marketStructure === "BULLISH" ||
    swingStructure.marketStructure === "BEARISH"
  ) {
    behavioralConfidence += 15;
  }

  // ==============================
  // BOS ALIGNMENT
  // ==============================
  if (
    swingStructure.bullishBOS ||
    swingStructure.bearishBOS
  ) {
    behavioralConfidence += 15;
  }

  // ==============================
  // EXPANSION READINESS
  // ==============================
  behavioralConfidence +=
    validation.expansionReadiness * 0.15;

  // ==============================
  // EXPANSION TRIGGER
  // ==============================
  if (validation.expansionTriggerActive)
    behavioralConfidence += 20;

  // Clamp
  behavioralConfidence =
    Math.max(
      0,
      Math.min(100, behavioralConfidence)
    );

  // ==============================
  // VALIDATION CONDITIONS
  // ==============================
  const behavioralValidation =
    continuationState.healthyStructure &&
    compressionState.constructiveCompression &&
    validation.expansionReadiness >= 60 &&
    validation.expansionTriggerActive &&
    behavioralConfidence >= 70;

  // ==============================
  // ENTRY ELIGIBILITY
  // ==============================
  const behavioralEntryEligible =
    behavioralValidation &&
    swingStructure.marketStructure !== "RANGE";

  return {
    behavioralValidation,
    behavioralConfidence,
    behavioralEntryEligible
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

  state.validation = {
    healthyStructure: false,
    continuationConfidence: 0,
    contradictionRisk: 0,
    reclaimQuality: 0,

    constructiveCompression: false,
    compressionQuality: 0,
    compressionBias: 0,

    dynamicDecayRisk: 0,

    expansionReadiness: 0,
    expansionPressure: 0,
    expansionBias: "NEUTRAL",
    expansionTriggerActive: false,
    expansionTriggerStrength: 0,

    displacementDetected: false,
    volatilityReleaseDetected: false,
    accelerationDetected: false,

    behavioralValidation: false,
    behavioralConfidence: 0,
    behavioralEntryEligible: false,
  };

  state.swingStructure = {
    highs: [],
    lows: [],
    lastHigh: null,
    lastLow: null,

    marketStructure: "UNKNOWN",

    higherHighs: 0,
    higherLows: 0,

    lowerHighs: 0,
    lowerLows: 0,

    bullishBOS: false,
    bearishBOS: false,

    structureBreakStrength: 0,

    lastBreakDirection: null
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

    const driftState =
      analyzeDirectionalDrift(
        state.memory.setup,
        state.signal
      );  

    const heavyChop =
      efficiency < 0.22 &&
      alternation > 0.72 &&
      !driftState.directionalDrift;

    const moderateChop =
      efficiency < 0.35 &&
      alternation > 0.58 &&
      !driftState.directionalDrift; 

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
      
    const continuationState =
      analyzeContinuationState(
        state.memory.setup,
        state.signal
      );

    state.validation = continuationState;

    const compressionState =
      analyzeCompression(
        state.memory.setup,
        state.signal
      );

    state.validation = {
      ...state.validation,
      ...compressionState
    };

    const dynamicDecayState =
      analyzeDynamicDecay({
        agingAnalysis,
        continuationState,
        compressionState,
        efficiency,
        alternation
      });

    state.validation = {
      ...state.validation,
      ...dynamicDecayState
    };

    const swingState =
      detectSwings(
        state.memory.setup
      );

    if (swingState.detectedHigh) {

      state.swingStructure.highs.push({
        price: swingState.swingHigh,
        timestamp: Date.now()
      });

      trim(
        state.swingStructure.highs,
        CONFIG.SWING_MEMORY_LIMIT
      );

      state.swingStructure.lastHigh =
        swingState.swingHigh;
    }

    if (swingState.detectedLow) {

      state.swingStructure.lows.push({
        price: swingState.swingLow,
        timestamp: Date.now()
      });

      trim(
        state.swingStructure.lows,
        CONFIG.SWING_MEMORY_LIMIT
      );

      state.swingStructure.lastLow =
        swingState.swingLow;
    }  

    const structureState =
      classifyMarketStructure(
        state.swingStructure
      );

    state.swingStructure = {
      ...state.swingStructure,
      ...structureState
    };

    const bosState =
      analyzeBreakOfStructure(
        state.swingStructure,
        price
      );

    state.swingStructure = {
      ...state.swingStructure,
      ...bosState
    };
    
    const expansionState =
      analyzeExpansionReadiness({
        continuationState,
        compressionState,
        swingStructure:
          state.swingStructure,
        efficiency,
        alternation
      });

    state.validation = {
      ...state.validation,
      ...expansionState
    };

    const expansionTriggerState =
      analyzeExpansionTrigger({
        setupMemory:
          state.memory.setup,

        compressionState,

        swingStructure:
          state.swingStructure,

        impulseAnalysis,

        atr
      });

    state.validation = {
      ...state.validation,
      ...expansionTriggerState
    };

    const behavioralState =
      analyzeBehavioralValidation({
        continuationState,
        compressionState,
        swingStructure:
          state.swingStructure,
        validation:
          state.validation
      });

    state.validation = {
      ...state.validation,
      ...behavioralState
    };

    const staleSetup =
      agingAnalysis.staleStructure;

    const decayingSetup =
      dynamicDecayState.decayingStructure;  

      
    console.log("[MARKET STRUCTURE]", {
      efficiency: efficiency.toFixed(2),
      alternation: alternation.toFixed(2),
      lastSwingHigh:
        state.swingStructure.lastHigh,

      lastSwingLow:
        state.swingStructure.lastLow,

      marketStructure:
        state.swingStructure.marketStructure,

      higherHighs:
        state.swingStructure.higherHighs,

      higherLows:
        state.swingStructure.higherLows,

      lowerHighs:
        state.swingStructure.lowerHighs,

      lowerLows:
        state.swingStructure.lowerLows,  

      bullishBOS:
        state.swingStructure.bullishBOS,

      bearishBOS:
        state.swingStructure.bearishBOS,

      structureBreakStrength:
        state.swingStructure.structureBreakStrength,

      lastBreakDirection:
        state.swingStructure.lastBreakDirection,  
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
    // CONTINUATION DETERIORATION
    // ==============================
    const deterioratingContinuation =
      continuationState.continuationConfidence < 35 &&
      continuationState.reclaimQuality < 25 &&
      continuationState.contradictionRisk > 40 &&
      !state.validation.expansionTriggerActive &&
      agingAnalysis.ageMinutes > 6;

    if (
      deterioratingContinuation &&
      !driftState.directionalDrift
    ) {

      console.log(
        "[SETUP INVALIDATED] Continuation deterioration",
        {
          continuationConfidence:
            continuationState.continuationConfidence.toFixed(2),

          reclaimQuality:
            continuationState.reclaimQuality.toFixed(2),

          ageMinutes:
            agingAnalysis.ageMinutes.toFixed(2)
        }
      );

      sendPhaseAlert({
        from: state.phase,
        to: "INVALIDATED",
        signal: state.signal,
        price,
        extra: {
          reason:
            "Continuation deterioration"
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

    let minPullback =
      state.lockedScores.trend > 30 ? 2 : 3;

    // Only ONE structural penalty allowed
    let penalty = 0;

    if (moderateChop)
      penalty = Math.max(penalty, 1);

    if (weakStructure)
      penalty = Math.max(penalty, 1);

    if (impulseWeak)
      penalty = Math.max(penalty, 1);

    if (decayingSetup)
      penalty = Math.max(penalty, 1);

    // Slow compression trends should not inflate aggressively
    if (
      driftState.directionalDrift &&
      driftState.staircaseTrend
    ) {
      penalty = Math.max(0, penalty - 1);
    }

    minPullback += penalty;

    // Hard cap prevents confirmation paralysis
    minPullback =
      Math.min(minPullback, 4);

    if (regimeAnalysis.explosiveRegime) {
      minPullback -= 1;
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
      Math.abs(last.delta) > avgDelta * 0.9;

    const directionalContinuation =
      state.signal === "BUY"
        ? last.delta > 0
        : last.delta < 0;

    const progressiveContinuation =
      continuationState.continuationConfidence > 45 &&
      continuationState.reclaimQuality > 30;

    const expansionContinuation =
      state.validation.expansionTriggerActive;

    const structuralContinuation =
      driftState.directionalDrift &&
      driftState.staircaseTrend;

    const resuming =
      (
        directionalContinuation &&
        strongMove
      ) ||
      progressiveContinuation ||
      expansionContinuation ||
      (
        structuralContinuation &&
        continuationState.reclaimQuality > 20
      );

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
      
    console.log("[CONTINUATION STATE]", {

      healthyStructure:
        continuationState.healthyStructure,

      continuationConfidence:
        continuationState.continuationConfidence.toFixed(2),

      contradictionRisk:
        continuationState.contradictionRisk.toFixed(2),

      reclaimQuality:
        continuationState.reclaimQuality.toFixed(2),

      stabilizationStrength:
        continuationState.stabilizationStrength.toFixed(2),

      weakeningOpposition:
        continuationState.weakeningOpposition,

      constructiveCompression:
        compressionState.constructiveCompression,

      compressionQuality:
        compressionState.compressionQuality.toFixed(2),

      compressionBias:
        compressionState.compressionBias.toFixed(2),

      volatilityCompression:
        compressionState.volatilityCompression,

      directionalCompression:
        compressionState.directionalCompression,

      dynamicDecayRisk:
        dynamicDecayState.dynamicDecayRisk.toFixed(2),

      lastSwingHigh:
        state.swingStructure.lastHigh,

      lastSwingLow:
        state.swingStructure.lastLow,

      detectedSwingHigh:
        swingState.detectedHigh,

      detectedSwingLow:
        swingState.detectedLow,  

      marketStructure:
        state.swingStructure.marketStructure,  

      bullishBOS:
        state.swingStructure.bullishBOS,

      bearishBOS:
        state.swingStructure.bearishBOS,

      expansionReadiness:
        state.validation.expansionReadiness.toFixed(2),

      expansionPressure:
        state.validation.expansionPressure.toFixed(2),

      expansionBias:
        state.validation.expansionBias, 
        
      expansionTriggerActive:
        state.validation.expansionTriggerActive,

      expansionTriggerStrength:
        state.validation.expansionTriggerStrength.toFixed(2),

      displacementDetected:
        state.validation.displacementDetected,

      volatilityReleaseDetected:
        state.validation.volatilityReleaseDetected,

      accelerationDetected:
        state.validation.accelerationDetected,  

    });


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
      continuationConfidence:
        continuationState.continuationConfidence.toFixed(2),

      contradictionRisk:
        continuationState.contradictionRisk.toFixed(2),

      reclaimQuality:
        continuationState.reclaimQuality.toFixed(2),

      healthyStructure:
        continuationState.healthyStructure,
      constructiveCompression:
        compressionState.constructiveCompression,

      compressionQuality:
        compressionState.compressionQuality.toFixed(2),
      
      dynamicDecayRisk:
        dynamicDecayState.dynamicDecayRisk.toFixed(2),  

      expansionReadiness:
        state.validation.expansionReadiness.toFixed(2),

      expansionPressure:
        state.validation.expansionPressure.toFixed(2),

      expansionBias:
        state.validation.expansionBias,

      expansionTriggerActive:
        state.validation.expansionTriggerActive,

      expansionTriggerStrength:
        state.validation.expansionTriggerStrength.toFixed(2),  

      directionalDrift:
        driftState.directionalDrift,

      driftStrength:
        driftState.driftStrength,

      staircaseTrend:
        driftState.staircaseTrend,  

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
      const setupScore =
        computeSetupScore(
          state.memory.setup,
          {
            signal: state.signal,
            price,
            ema50,
            atr
          }
        );

      const momentumScore =
        computeMomentumScore(
          state.memory.setup,
          {
            signal: state.signal,
            atr
          }
        );

      state.lockedScores.setup =
        setupScore;

      state.liveScore.momentum =
        momentumScore;

      const totalScore =
        state.lockedScores.trend +
        setupScore +
        momentumScore;

      const scoreQualified =
        totalScore >= CONFIG.THRESHOLD;

      const behavioralQualified =
        state.validation
          .behavioralEntryEligible;

      console.log("[ENTRY AUTHORITY]", {
        totalScore:
          totalScore.toFixed(2),

        scoreQualified,

        behavioralQualified,

        behavioralConfidence:
          state.validation
            .behavioralConfidence
            .toFixed(2),

        expansionReadiness:
          state.validation
            .expansionReadiness
            .toFixed(2),

        expansionTrigger:
          state.validation
            .expansionTriggerActive,

        marketStructure:
          state.swingStructure
            .marketStructure
      });

      if (
        scoreQualified ||
        behavioralQualified
      ) {

        console.log(
          "[DIRECT ENTRY] Behavioral execution validated"
        );

        sendPhaseAlert({
          from: state.phase,
          to: "ENTRY",
          signal: state.signal,
          price,
          scores: {
            trend:
              state.lockedScores.trend,

            setup:
              setupScore,

            momentum:
              momentumScore,

            final:
              totalScore
          },
          extra: {
            reason:
              behavioralQualified
                ? "Behavioral validation entry"
                : "Score-qualified entry"
          }
        });
        
        reset();

        return {
          action:
            state.signal.toLowerCase()
        };
      }

      return { action: null };
    }
  }

  return { action: null };
}

module.exports = { strategyEngine };