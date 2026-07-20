const MODE = Object.freeze({ OFF: "OFF", OBSERVE: "OBSERVE" });

function booleanEnv(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function numberEnv(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function loadAiAnalystConfig(env = process.env) {
  const requestedMode = String(env.AI_ANALYST_MODE || MODE.OFF).toUpperCase();
  const mode = requestedMode === MODE.OBSERVE ? MODE.OBSERVE : MODE.OFF;

  return Object.freeze({
    mode,
    model: env.AI_ANALYST_MODEL || "gpt-5.4-mini",
    signalsEnabled: booleanEnv(env.AI_ANALYST_SIGNALS_ENABLED, false),
    controlsEnabled: booleanEnv(env.AI_ANALYST_CONTROLS_ENABLED, false),
    exitsEnabled: booleanEnv(env.AI_ANALYST_EXITS_ENABLED, false),
    telegramEnabled: booleanEnv(env.AI_ANALYST_TELEGRAM_ENABLED, false),
    reasoningEffort: env.AI_ANALYST_REASONING_EFFORT || "low",
    timeoutMs: numberEnv(env.AI_ANALYST_TIMEOUT_MS, 30_000, { min: 1_000, max: 120_000 }),
    controlIntervalMinutes: numberEnv(env.AI_ANALYST_CONTROL_INTERVAL_MINUTES, 30, { min: 5, max: 240 }),
    controlDedupMinutes: numberEnv(env.AI_ANALYST_CONTROL_DEDUP_MINUTES, 10, { min: 0, max: 60 }),
    maxRpm: numberEnv(env.AI_ANALYST_MAX_RPM, 4, { min: 1, max: 60 }),
    maxCallsPerDay: numberEnv(env.AI_ANALYST_MAX_CALLS_PER_DAY, 60, { min: 1, max: 10_000 }),
    maxDailyCostUsd: numberEnv(env.AI_ANALYST_MAX_DAILY_COST_USD, 1, { min: 0.01, max: 1_000 }),
    maxQueue: numberEnv(env.AI_ANALYST_MAX_QUEUE, 100, { min: 1, max: 10_000 }),
    candleLimits: Object.freeze({
      m1: numberEnv(env.AI_ANALYST_M1_CANDLES, 120, { min: 20, max: 500 }),
      m5: numberEnv(env.AI_ANALYST_M5_CANDLES, 96, { min: 20, max: 500 }),
      m30: numberEnv(env.AI_ANALYST_M30_CANDLES, 100, { min: 96, max: 100 }),
    }),
    imageDetail: env.AI_ANALYST_IMAGE_DETAIL || "high",
    apiKey: env.OPENAI_API_KEY || null,
    schemaVersion: "ai-analyst-schema-v1",
    promptVersion: "ai-analyst-prompt-v1",
  });
}

function isObserveEnabled(config) {
  return config?.mode === MODE.OBSERVE;
}

module.exports = { MODE, booleanEnv, isObserveEnabled, loadAiAnalystConfig, numberEnv };
