const crypto = require("crypto");
const { AnalysisLimiter } = require("./limits");
const { IndependentCandleBuffer } = require("./candles");
const { renderCleanCandlestickChart } = require("./chartRenderer");
const { loadAiAnalystConfig, isObserveEnabled } = require("./config");
const { formatOutcomeReview, formatSignalReview } = require("./formatting");
const { OpenAIStageRunner, createOpenAIClient } = require("./openaiRunner");
const { buildBlindPayload, buildComparisonPayload, buildOutcomePayload } = require("./payloads");
const { AsyncWorkQueue } = require("./queue");
const { BlindAssessmentSchema, OutcomeReviewSchema, SignalComparisonSchema } = require("./schemas");

function clonePlain(value, depth = 0) {
  if (depth > 12 || value == null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return Object.freeze(value.slice(0, 500).map((item) => clonePlain(item, depth + 1)));
  if (typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (typeof child !== "function" && child !== undefined) output[key] = clonePlain(child, depth + 1);
    }
    return Object.freeze(output);
  }
  return null;
}

function timestampMs(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function publicMarket(price, symbol, sessionLabel, timestamp) {
  const bid = price?.bid == null ? NaN : Number(price.bid);
  const ask = price?.ask == null ? NaN : Number(price.ask);
  return Object.freeze({
    timestamp: new Date(timestamp).toISOString(), symbol: String(symbol),
    bid: Number.isFinite(bid) ? bid : null, ask: Number.isFinite(ask) ? ask : null,
    spread: Number.isFinite(bid) && Number.isFinite(ask) ? Math.abs(ask - bid) : null,
    sessionLabel: String(sessionLabel || "UNKNOWN"),
  });
}

function failureDocument({ config, stage, signalEventId, tradeId, error }) {
  return {
    runId: `airun-${crypto.randomUUID()}`, stage, signalEventId, tradeId,
    schemaVersion: config.schemaVersion, promptVersion: config.promptVersion,
    model: config.model, store: false, status: "PERSISTENCE_ERROR",
    failure: { name: error?.name || "Error", message: String(error?.message || error).slice(0, 500) },
    startedAt: new Date(), completedAt: new Date(),
  };
}

class IndependentAiMarketAnalyst {
  constructor({ config = loadAiAnalystConfig(), repository, client = null, notify = null, now = () => new Date(), chartRenderer = renderCleanCandlestickChart } = {}) {
    if (!repository) throw new Error("AI analyst repository is required");
    this.config = config;
    this.repository = repository;
    this.notify = notify;
    this.now = now;
    this.chartRenderer = chartRenderer;
    this.buffer = new IndependentCandleBuffer(config.candleLimits);
    this.lastSignalAt = this.now().getTime();
    this.lastControlBucket = null;
    this.dispositionKeys = new Set();
    this.outcomeKeys = new Set();
    this.queue = new AsyncWorkQueue({
      maxSize: config.maxQueue,
      onError: (error, label) => this.#recordQueueFailure(error, label),
    });
    this.limiter = new AnalysisLimiter({
      repository, maxRpm: config.maxRpm, maxCallsPerDay: config.maxCallsPerDay,
      maxDailyCostUsd: config.maxDailyCostUsd, now,
    });
    const openAIClient = client || (isObserveEnabled(config) && config.apiKey ? createOpenAIClient(config.apiKey) : null);
    this.runner = openAIClient ? new OpenAIStageRunner({ client: openAIClient, repository, limiter: this.limiter, config, now }) : null;
  }

  enabled(feature) { return isObserveEnabled(this.config) && Boolean(this.config[feature]); }
  ingestTick(tick) { try { return this.buffer.ingestTick(tick); } catch (_) { return false; } }

  warmup(fetchCandles, symbol, cutoff = this.now()) {
    if (!isObserveEnabled(this.config) || typeof fetchCandles !== "function") return false;
    return this.queue.enqueue("WARMUP", async () => {
      for (const [frame, apiFrame] of [["m30", "30m"], ["m5", "5m"], ["m1", "1m"]]) {
        const rows = await fetchCandles(symbol, apiFrame, this.config.candleLimits[frame]);
        this.buffer.loadHistory(frame, rows, timestampMs(cutoff));
      }
      await this.repository.updateRuntime({ lastWarmupAt: this.now(), heartbeatAt: this.now() });
    });
  }

  captureSignal({ symbol, price, sessionLabel, deterministicContext = {}, observedAt = this.now() }) {
    const signalEventId = `signal-${crypto.randomUUID()}`;
    const timestamp = timestampMs(observedAt);
    this.lastSignalAt = timestamp;
    if (!this.enabled("signalsEnabled")) return Object.freeze({ signalEventId, queued: false });
    const capture = Object.freeze({
      signalEventId,
      market: publicMarket(price, symbol, sessionLabel, timestamp),
      candles: this.buffer.snapshot(timestamp),
      deterministicContext: clonePlain(deterministicContext),
    });
    const queued = this.queue.enqueue(`SIGNAL:${signalEventId}`, () => this.#captureAndBlind(capture, "SIGNAL"));
    if (!queued) this.#recordQueueLimit(signalEventId, "BLIND");
    this.queue.enqueue(`RUNTIME:${signalEventId}`, () => this.repository.updateRuntime({ lastSignalAt: new Date(timestamp), heartbeatAt: this.now() }));
    return Object.freeze({ signalEventId, queued });
  }

  recordDisposition({ signalEventId, disposition, tradeId = null, actualDirection = null, actualEntry = null, actualSL = null, actualTP = null, executionMode = null }) {
    if (!this.enabled("signalsEnabled") || !signalEventId) return false;
    const key = `${signalEventId}:1`;
    if (this.dispositionKeys.has(key)) return false;
    this.dispositionKeys.add(key);
    const queued = this.queue.enqueue(`DISPOSITION:${signalEventId}`, async () => {
      await this.repository.insertSignalTradeLink({
        schemaVersion: this.config.schemaVersion, signalEventId, linkVersion: 1,
        linkType: tradeId ? "TRADE_LINK" : "DISPOSITION", disposition, tradeId,
      });
      if (!tradeId || !executionMode) return;
      await this.#compare({ signalEventId, tradeId, actualDirection, actualEntry, actualSL, actualTP, executionMode });
    });
    if (!queued) this.dispositionKeys.delete(key);
    return queued;
  }

  linkTrade({ signalEventId, tradeId, disposition = "TRADE_LINKED_LATE", actualDirection = null, actualEntry = null, actualSL = null, actualTP = null, executionMode = null }) {
    if (!this.enabled("signalsEnabled") || !signalEventId || !tradeId) return false;
    const key = `${signalEventId}:2`;
    if (this.dispositionKeys.has(key)) return false;
    this.dispositionKeys.add(key);
    const queued = this.queue.enqueue(`LINK:${signalEventId}`, async () => {
      await this.repository.insertSignalTradeLink({ schemaVersion: this.config.schemaVersion, signalEventId, linkVersion: 2, linkType: "TRADE_LINK", disposition, tradeId });
      if (executionMode) await this.#compare({ signalEventId, tradeId, actualDirection, actualEntry, actualSL, actualTP, executionMode });
    });
    if (!queued) this.dispositionKeys.delete(key);
    return queued;
  }

  observeExit({ signalEventId, tradeId, symbol, price, sessionLabel, finalOutcome, observedAt = this.now() }) {
    if (!this.enabled("exitsEnabled") || !signalEventId || !tradeId) return false;
    const outcomeKey = `${tradeId}:${this.config.promptVersion}`;
    if (this.outcomeKeys.has(outcomeKey)) return false;
    this.outcomeKeys.add(outcomeKey);
    const timestamp = timestampMs(observedAt);
    const capture = Object.freeze({ signalEventId, tradeId, market: publicMarket(price, symbol, sessionLabel, timestamp), candles: this.buffer.snapshot(timestamp), finalOutcome: clonePlain(finalOutcome) });
    const queued = this.queue.enqueue(`OUTCOME:${tradeId}`, async () => {
      const { snapshotId } = await this.#persistSnapshot(capture, "EXIT");
      const blind = await this.repository.findBlind(signalEventId);
      const comparison = await this.repository.findComparison(signalEventId);
      if (!blind?.assessment || !comparison?.comparison) return this.#recordPrerequisite(signalEventId, tradeId, "OUTCOME", "blind assessment or comparison missing");
      const payload = buildOutcomePayload({ blindAssessment: blind.assessment, comparison: comparison.comparison, finalOutcome: capture.finalOutcome });
      if (!this.runner) return this.#recordUnavailable(signalEventId, tradeId, "OUTCOME");
      const result = await this.runner.run({ stage: "OUTCOME", signalEventId, tradeId, payload, schema: OutcomeReviewSchema, schemaName: "outcome_review" });
      if (!result.ok) return;
      const outcome = await this.repository.insertOutcomeReview({
        schemaVersion: this.config.schemaVersion, promptVersion: this.config.promptVersion,
        signalEventId, tradeId, snapshotId, blindAssessmentHash: blind.canonicalHash,
        comparisonHash: comparison.canonicalHash, originalGrade: comparison.comparison.grade,
        review: result.parsed, analysisRunId: result.runId,
      });
      if (this.config.telegramEnabled && this.notify) {
        const event = await this.repository.findSignalEvent(signalEventId);
        await this.#notify(formatOutcomeReview({
          tradeId, blind: blind.assessment, comparison: comparison.comparison,
          outcome: outcome.review, botAction: event?.deterministicContext?.direction,
          finalOutcome: capture.finalOutcome,
        }));
      }
    });
    if (!queued) this.outcomeKeys.delete(outcomeKey);
    return queued;
  }

  maybeCaptureControl({ symbol, price, sessionDecision, observedAt = this.now() }) {
    if (!this.enabled("controlsEnabled") || !sessionDecision?.allowed || !sessionDecision?.withinWindow) return false;
    const timestamp = timestampMs(observedAt);
    const intervalMs = this.config.controlIntervalMinutes * 60_000;
    const bucket = Math.floor(timestamp / intervalMs) * intervalMs;
    if (this.lastControlBucket === bucket || timestamp - this.lastSignalAt < intervalMs) return false;
    this.lastControlBucket = bucket;
    const controlEventId = `control-${new Date(bucket).toISOString()}`;
    const capture = Object.freeze({
      signalEventId: controlEventId, eventKey: `CONTROL:${symbol}:${bucket}`,
      market: publicMarket(price, symbol, sessionDecision.sessionLabel, timestamp), candles: this.buffer.snapshot(timestamp), deterministicContext: null,
    });
    return this.queue.enqueue(`CONTROL:${bucket}`, async () => {
      if (await this.repository.hasEventKey(capture.eventKey)) return;
      if (await this.repository.hasSignalNear(timestamp, this.config.controlDedupMinutes * 60_000)) return;
      await this.#captureAndBlind(capture, "CONTROL");
      await this.repository.updateRuntime({ lastControlAt: new Date(timestamp), heartbeatAt: this.now() });
    });
  }

  async #captureAndBlind(capture, eventType) {
    await this.repository.insertSignalEvent({
      schemaVersion: this.config.schemaVersion, signalEventId: capture.signalEventId,
      eventKey: capture.eventKey, eventType, observedAt: new Date(capture.market.timestamp),
      symbol: capture.market.symbol, sessionLabel: capture.market.sessionLabel,
      deterministicContext: eventType === "SIGNAL" ? capture.deterministicContext : null,
    });
    const { snapshotId, charts } = await this.#persistSnapshot(capture, eventType);
    const correlationId = crypto.randomUUID();
    const payload = buildBlindPayload({
      correlationId, ...capture.market, candles: capture.candles,
      charts: Object.fromEntries(charts.map((chart) => [chart.timeframe, { contentType: "image/png", sha256: chart.pngSha256 }])),
    });
    const images = charts.map((chart) => `data:image/png;base64,${chart.png.toString("base64")}`);
    if (!this.runner) return this.#recordUnavailable(capture.signalEventId, null, "BLIND");
    const result = await this.runner.run({ stage: "BLIND", signalEventId: capture.signalEventId, payload, schema: BlindAssessmentSchema, schemaName: "blind_market_assessment", images });
    if (!result.ok) return;
    await this.repository.insertBlindAssessment({
      schemaVersion: this.config.schemaVersion, promptVersion: this.config.promptVersion,
      signalEventId: capture.signalEventId, snapshotId, correlationId,
      assessment: result.parsed, analysisRunId: result.runId,
    });
  }

  async #compare({ signalEventId, tradeId, actualDirection, actualEntry, actualSL, actualTP, executionMode }) {
    const blind = await this.repository.findBlind(signalEventId);
    if (!blind?.assessment) return this.#recordPrerequisite(signalEventId, tradeId, "COMPARISON", "blind assessment missing");
    const payload = buildComparisonPayload({ blindAssessment: blind.assessment, actualDirection, actualEntry, actualSL, actualTP, executionMode });
    if (!this.runner) return this.#recordUnavailable(signalEventId, tradeId, "COMPARISON");
    const result = await this.runner.run({ stage: "COMPARISON", signalEventId, tradeId, payload, schema: SignalComparisonSchema, schemaName: "signal_comparison" });
    if (!result.ok) return;
    const comparison = await this.repository.insertSignalComparison({
      schemaVersion: this.config.schemaVersion, promptVersion: this.config.promptVersion,
      signalEventId, tradeId, blindAssessmentHash: blind.canonicalHash,
      comparison: result.parsed, analysisRunId: result.runId,
    });
    if (this.config.telegramEnabled && this.notify) {
      await this.#notify(formatSignalReview({
        key: tradeId || signalEventId, blind: blind.assessment,
        comparison: comparison.comparison, botAction: actualDirection,
      }));
    }
  }

  async #persistSnapshot(capture, snapshotType) {
    const snapshotId = `snapshot-${crypto.randomUUID()}`;
    const renderedCharts = [];
    const chartFailures = [];
    for (const timeframe of ["m30", "m5", "m1"]) {
      try {
        const png = this.chartRenderer(capture.candles[timeframe], timeframe);
        renderedCharts.push({ timeframe, png, pngSha256: require("./canonical").sha256(png) });
      } catch (error) {
        chartFailures.push({ timeframe, message: String(error?.message || error).slice(0, 200) });
      }
    }
    await this.repository.insertMarketSnapshot({
      schemaVersion: this.config.schemaVersion, snapshotId, signalEventId: capture.signalEventId,
      tradeId: capture.tradeId || null, snapshotType, observedAt: new Date(capture.market.timestamp),
      market: capture.market, candles: capture.candles,
      chartHashes: Object.fromEntries(renderedCharts.map((chart) => [chart.timeframe, chart.pngSha256])),
      chartFailures,
    });
    if (chartFailures.length) {
      const error = new Error(`Clean chart rendering incomplete: ${chartFailures.map((failure) => failure.timeframe).join(",")}`);
      error.name = "InsufficientMarketDataError";
      throw error;
    }
    const charts = [];
    for (const rendered of renderedCharts) {
      const persisted = await this.repository.insertMarketChart({
        schemaVersion: this.config.schemaVersion, snapshotId, signalEventId: capture.signalEventId,
        snapshotType, timeframe: rendered.timeframe, width: 1024, height: 576, png: rendered.png,
      });
      charts.push({ timeframe: rendered.timeframe, png: rendered.png, pngSha256: persisted.pngSha256 || rendered.pngSha256 });
    }
    return { snapshotId, charts };
  }

  async #notify(message) { try { await this.notify(message, { parse_mode: "HTML" }); } catch (_) {} }
  async #recordPrerequisite(signalEventId, tradeId, stage, message) {
    await this.repository.insertAnalysisRun({
      runId: `airun-${crypto.randomUUID()}`, schemaVersion: this.config.schemaVersion,
      promptVersion: this.config.promptVersion, model: this.config.model, store: false,
      signalEventId, tradeId, stage, status: "PREREQUISITE_MISSING",
      failure: { message }, startedAt: this.now(), completedAt: this.now(),
    });
  }
  async #recordUnavailable(signalEventId, tradeId, stage) {
    await this.repository.insertAnalysisRun({
      runId: `airun-${crypto.randomUUID()}`, schemaVersion: this.config.schemaVersion,
      promptVersion: this.config.promptVersion, model: this.config.model, store: false,
      signalEventId, tradeId, stage, status: "API_ERROR",
      failure: { name: "ConfigurationError", message: "OpenAI client unavailable; credential not configured" },
      startedAt: this.now(), completedAt: this.now(),
    });
  }
  #recordQueueLimit(signalEventId, stage) {
    Promise.resolve(this.repository.insertAnalysisRun({
      runId: `airun-${crypto.randomUUID()}`, schemaVersion: this.config.schemaVersion,
      promptVersion: this.config.promptVersion, model: this.config.model, store: false,
      signalEventId, stage, status: "RATE_LIMITED", failure: { message: "analysis queue full" },
      startedAt: this.now(), completedAt: this.now(),
    })).catch(() => {});
  }
  #recordQueueFailure(error, label) {
    const [stage, identifier = null] = String(label).split(":");
    const document = failureDocument({
      config: this.config,
      stage,
      signalEventId: ["SIGNAL", "DISPOSITION", "LINK", "CONTROL"].includes(stage) ? identifier : null,
      tradeId: stage === "OUTCOME" ? identifier : null,
      error,
    });
    if (error?.name === "InsufficientMarketDataError") document.status = "INSUFFICIENT_DATA";
    Promise.resolve(this.repository.insertAnalysisRun(document)).catch(() => {});
  }
  async idle() { await this.queue.idle(); }
  status() {
    const { apiKey, ...safeConfig } = this.config;
    return {
      ...safeConfig,
      credentialConfigured: Boolean(apiKey),
      operational: isObserveEnabled(this.config) ? Boolean(this.runner) : false,
      queueSize: this.queue.size(),
    };
  }
}

module.exports = { IndependentAiMarketAnalyst, clonePlain, publicMarket };
