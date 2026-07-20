const crypto = require("crypto");
const OpenAI = require("openai");
const { zodTextFormat } = require("openai/helpers/zod");
const { canonicalJson, sha256 } = require("./canonical");

const PRICING_PER_MILLION = Object.freeze({ input: 0.75, cachedInput: 0.075, output: 4.5 });

const SYSTEM_PROMPTS = Object.freeze({
  BLIND: "You are an independent market analyst. Evaluate only the supplied timestamped raw OHLC and clean charts. Do not infer or ask for a bot signal. Return only the required schema. Express uncertainty explicitly.",
  COMPARISON: "Independently compare the already-persisted blind assessment with the disclosed execution parameters. Do not assume any undisclosed strategy logic, indicators, score, outcome, or hindsight. Return only the required schema.",
  OUTCOME: "Review the immutable prior assessment and the sanitized final outcome. Do not revise or replace the original grade. Separate process observations from hindsight and return only the required schema.",
});

function usageFromResponse(response) {
  return {
    inputTokens: Number(response?.usage?.input_tokens || 0),
    outputTokens: Number(response?.usage?.output_tokens || 0),
    cachedInputTokens: Number(response?.usage?.input_tokens_details?.cached_tokens || 0),
  };
}

function costForUsage(usage) {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (uncached * PRICING_PER_MILLION.input + usage.cachedInputTokens * PRICING_PER_MILLION.cachedInput + usage.outputTokens * PRICING_PER_MILLION.output) / 1_000_000;
}

function terminalStatus(error) {
  if (error?.name === "RedactionRejectedError") return "REDACTION_REJECTED";
  if (error?.name === "AbortError" || /timeout/i.test(error?.message || "")) return "TIMEOUT";
  if (error?.name === "ZodError" || /schema|parse|output_parsed/i.test(error?.message || "")) return "INVALID_SCHEMA";
  if (error?.status === 429) return "RATE_LIMITED";
  return "API_ERROR";
}

function findRefusal(response) {
  for (const item of response?.output || []) {
    for (const content of item?.content || []) if (content?.type === "refusal") return content.refusal || "refused";
  }
  return null;
}

function createOpenAIClient(apiKey) { return new OpenAI({ apiKey }); }

class OpenAIStageRunner {
  constructor({ client, repository, limiter, config, now = () => new Date() }) {
    this.client = client;
    this.repository = repository;
    this.limiter = limiter;
    this.config = config;
    this.now = now;
  }

  async run({ stage, signalEventId = null, tradeId = null, payload, schema, schemaName, images = [] }) {
    const runId = `airun-${crypto.randomUUID()}`;
    const startedAt = this.now();
    const reservation = await this.limiter.reserve();
    if (!reservation.allowed) {
      await this.#record({ runId, stage, signalEventId, tradeId, startedAt, completedAt: this.now(), status: reservation.status, requestHash: sha256(canonicalJson(payload)) });
      return { ok: false, status: reservation.status, runId };
    }

    let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let costUsd = 0;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let response;
      try {
        const content = [{ type: "input_text", text: canonicalJson(payload) }];
        for (const image of images) content.push({ type: "input_image", image_url: image, detail: this.config.imageDetail });
        response = await this.client.responses.parse({
          model: this.config.model,
          store: false,
          reasoning: { effort: this.config.reasoningEffort },
          input: [{ role: "system", content: SYSTEM_PROMPTS[stage] }, { role: "user", content }],
          text: { format: zodTextFormat(schema, schemaName) },
        }, { signal: controller.signal });
      } finally { clearTimeout(timeout); }

      usage = usageFromResponse(response);
      costUsd = costForUsage(usage);
      const refusal = findRefusal(response);
      if (refusal) {
        await this.limiter.reconcile(reservation, costUsd, usage);
        await this.#record({ runId, stage, signalEventId, tradeId, startedAt, completedAt: this.now(), status: "REFUSED", requestHash: sha256(canonicalJson(payload)), usage, costUsd, failure: { message: String(refusal).slice(0, 500) } });
        return { ok: false, status: "REFUSED", runId };
      }
      if (!response?.output_parsed) {
        const error = new Error("Responses API output_parsed missing after strict parse");
        error.name = "ZodError";
        throw error;
      }
      const parsed = schema.parse(response.output_parsed);
      await this.limiter.reconcile(reservation, costUsd, usage);
      const recorded = await this.#record({
        runId, stage, signalEventId, tradeId, startedAt, completedAt: this.now(), status: "SUCCEEDED",
        requestHash: sha256(canonicalJson(payload)), responseId: response.id || null,
        responseHash: sha256(canonicalJson(parsed)), usage, costUsd,
      });
      if (!recorded) return { ok: false, status: "PERSISTENCE_ERROR", runId };
      return { ok: true, status: "SUCCEEDED", runId, parsed, usage, costUsd };
    } catch (error) {
      const status = terminalStatus(error);
      const conservativeCost = costUsd || reservation.estimatedCostUsd;
      try { await this.limiter.reconcile(reservation, conservativeCost, usage); } catch (_) {}
      await this.#record({
        runId, stage, signalEventId, tradeId, startedAt, completedAt: this.now(), status,
        requestHash: sha256(canonicalJson(payload)), usage, costUsd: conservativeCost,
        failure: { name: error?.name || "Error", message: String(error?.message || error).slice(0, 500), code: error?.code || null },
      });
      return { ok: false, status, runId };
    }
  }

  async #record(document) {
    try {
      await this.repository.insertAnalysisRun({
        ...document, schemaVersion: this.config.schemaVersion, promptVersion: this.config.promptVersion,
        model: this.config.model, store: false,
      });
      return true;
    } catch (_) {
      // A diagnostic write must never escape into the trading process.
      return false;
    }
  }
}

module.exports = { OpenAIStageRunner, PRICING_PER_MILLION, SYSTEM_PROMPTS, costForUsage, createOpenAIClient, terminalStatus, usageFromResponse };
