const { Binary } = require("mongodb");
const { withCanonicalHash } = require("./canonical");

const IMMUTABLE_COLLECTIONS = Object.freeze([
  "ai_signal_events", "ai_signal_trade_links", "ai_market_snapshots", "ai_market_charts",
  "ai_blind_assessments", "ai_signal_comparisons", "ai_outcome_reviews", "ai_analysis_runs",
]);
const OPERATIONAL_COLLECTIONS = Object.freeze(["ai_usage_budgets", "ai_analyst_runtime"]);
const ALL_COLLECTIONS = Object.freeze([...IMMUTABLE_COLLECTIONS, ...OPERATIONAL_COLLECTIONS]);

function stamp(document, now = new Date()) {
  return withCanonicalHash({ ...document, createdAt: document.createdAt || now });
}

function duplicateKey(error) { return error?.code === 11000; }

class MongoAiAnalystRepository {
  constructor(getDb) { this.getDb = getDb; }
  collection(name) { return this.getDb().collection(name); }

  async insert(name, document) {
    if (!IMMUTABLE_COLLECTIONS.includes(name)) throw new Error(`AI insert-only repository rejected collection ${name}`);
    const persisted = stamp(document);
    const insertionCopy = { ...persisted };
    const { acknowledged, insertedId } = await this.collection(name).insertOne(insertionCopy);
    if (!acknowledged || insertedId == null) {
      throw new Error(`AI immutable insert was not acknowledged for collection ${name}`);
    }
    return persisted;
  }

  insertSignalEvent(document) { return this.insert("ai_signal_events", document); }
  insertSignalTradeLink(document) { return this.insert("ai_signal_trade_links", document); }
  insertMarketSnapshot(document) { return this.insert("ai_market_snapshots", document); }
  insertBlindAssessment(document) { return this.insert("ai_blind_assessments", document); }
  insertSignalComparison(document) { return this.insert("ai_signal_comparisons", document); }
  insertOutcomeReview(document) { return this.insert("ai_outcome_reviews", document); }
  insertAnalysisRun(document) { return this.insert("ai_analysis_runs", document); }

  async insertMarketChart(document) {
    const png = Buffer.from(document.png);
    return this.insert("ai_market_charts", { ...document, png: new Binary(png), pngSha256: require("./canonical").sha256(png) });
  }

  async findBlind(signalEventId) {
    return this.collection("ai_blind_assessments").findOne({ signalEventId }, { sort: { createdAt: -1 } });
  }

  async findSignalEvent(signalEventId) {
    return this.collection("ai_signal_events").findOne({ signalEventId });
  }

  async hasEventKey(eventKey) {
    return Boolean(await this.collection("ai_signal_events").findOne({ eventKey }, { projection: { _id: 1 } }));
  }

  async findComparison(signalEventId) {
    return this.collection("ai_signal_comparisons").findOne({ signalEventId }, { sort: { createdAt: -1 } });
  }

  async hasSignalNear(timestamp, proximityMs) {
    const date = new Date(timestamp);
    return Boolean(await this.collection("ai_signal_events").findOne({
      eventType: "SIGNAL",
      observedAt: { $gte: new Date(date.getTime() - proximityMs), $lte: new Date(date.getTime() + proximityMs) },
    }, { projection: { _id: 1 } }));
  }

  async reserveBudget({ dayKey, maxCalls, maxCostUsd, estimatedCostUsd, now = new Date() }) {
    const collection = this.collection("ai_usage_budgets");
    const filter = {
      dayKey,
      calls: { $lt: maxCalls },
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ["$costUsd", 0] }, { $ifNull: ["$reservedCostUsd", 0] }, estimatedCostUsd] },
          maxCostUsd,
        ],
      },
    };
    let result = await collection.findOneAndUpdate(
      filter,
      { $inc: { calls: 1, reservedCostUsd: estimatedCostUsd }, $set: { updatedAt: now } },
      { returnDocument: "after" },
    );
    if (result) return result;
    try {
      await collection.insertOne({
        dayKey, calls: 1, costUsd: 0, reservedCostUsd: estimatedCostUsd,
        inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
        createdAt: now, updatedAt: now,
      });
      return collection.findOne({ dayKey });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      result = await collection.findOneAndUpdate(
        filter,
        { $inc: { calls: 1, reservedCostUsd: estimatedCostUsd }, $set: { updatedAt: now } },
        { returnDocument: "after" },
      );
      return result || null;
    }
  }

  async reserveRate({ minuteKey, maxRpm, now = new Date() }) {
    const collection = this.collection("ai_analyst_runtime");
    const filter = {
      runtimeKey: "singleton",
      $or: [{ rateMinuteKey: { $ne: minuteKey } }, { rateCalls: { $lt: maxRpm } }],
    };
    const update = [
      {
        $set: {
          runtimeKey: "singleton",
          rateCalls: { $cond: [{ $eq: ["$rateMinuteKey", minuteKey] }, { $add: [{ $ifNull: ["$rateCalls", 0] }, 1] }, 1] },
          rateMinuteKey: minuteKey,
          updatedAt: now,
          createdAt: { $ifNull: ["$createdAt", now] },
        },
      },
    ];
    let result = await collection.findOneAndUpdate(filter, update, { returnDocument: "after" });
    if (result) return result;
    try {
      await collection.insertOne({ runtimeKey: "singleton", rateMinuteKey: minuteKey, rateCalls: 1, createdAt: now, updatedAt: now });
      return collection.findOne({ runtimeKey: "singleton" });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      result = await collection.findOneAndUpdate(filter, update, { returnDocument: "after" });
      return result || null;
    }
  }

  async reconcileBudget({ dayKey, estimatedCostUsd, actualCostUsd, usage }) {
    await this.collection("ai_usage_budgets").updateOne(
      { dayKey },
      {
        $inc: {
          reservedCostUsd: -estimatedCostUsd,
          costUsd: actualCostUsd,
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
          cachedInputTokens: usage.cachedInputTokens || 0,
        },
        $set: { updatedAt: new Date() },
      },
    );
  }

  async updateRuntime(fields) {
    return this.collection("ai_analyst_runtime").updateOne(
      { runtimeKey: "singleton" },
      { $set: { ...fields, updatedAt: new Date() }, $setOnInsert: { runtimeKey: "singleton", createdAt: new Date() } },
      { upsert: true },
    );
  }

  async getRuntime() { return this.collection("ai_analyst_runtime").findOne({ runtimeKey: "singleton" }); }
}

class MemoryAiAnalystRepository {
  constructor() {
    this.documents = Object.fromEntries(ALL_COLLECTIONS.map((name) => [name, []]));
    this.runtime = null;
  }
  async insert(name, document) {
    const persisted = stamp(document);
    this.documents[name].push(persisted);
    return persisted;
  }
  insertSignalEvent(d) { return this.insert("ai_signal_events", d); }
  insertSignalTradeLink(d) { return this.insert("ai_signal_trade_links", d); }
  insertMarketSnapshot(d) { return this.insert("ai_market_snapshots", d); }
  insertMarketChart(d) { return this.insert("ai_market_charts", { ...d, png: Buffer.from(d.png) }); }
  insertBlindAssessment(d) { return this.insert("ai_blind_assessments", d); }
  insertSignalComparison(d) { return this.insert("ai_signal_comparisons", d); }
  insertOutcomeReview(d) { return this.insert("ai_outcome_reviews", d); }
  insertAnalysisRun(d) { return this.insert("ai_analysis_runs", d); }
  async findBlind(id) { return this.documents.ai_blind_assessments.findLast((d) => d.signalEventId === id) || null; }
  async findSignalEvent(id) { return this.documents.ai_signal_events.findLast((d) => d.signalEventId === id) || null; }
  async hasEventKey(eventKey) { return this.documents.ai_signal_events.some((d) => d.eventKey === eventKey); }
  async findComparison(id) { return this.documents.ai_signal_comparisons.findLast((d) => d.signalEventId === id) || null; }
  async hasSignalNear(timestamp, ms) { return this.documents.ai_signal_events.some((d) => d.eventType === "SIGNAL" && Math.abs(new Date(d.observedAt) - timestamp) <= ms); }
  async reserveBudget({ dayKey, maxCalls, maxCostUsd, estimatedCostUsd }) {
    let row = this.documents.ai_usage_budgets.find((d) => d.dayKey === dayKey);
    if (!row) { row = { dayKey, calls: 0, costUsd: 0, reservedCostUsd: 0 }; this.documents.ai_usage_budgets.push(row); }
    if (row.calls >= maxCalls || row.costUsd + row.reservedCostUsd + estimatedCostUsd > maxCostUsd) return null;
    row.calls++; row.reservedCostUsd += estimatedCostUsd; return row;
  }
  async reserveRate({ minuteKey, maxRpm }) {
    if (this.runtime?.rateMinuteKey === minuteKey && Number(this.runtime.rateCalls || 0) >= maxRpm) return null;
    if (this.runtime?.rateMinuteKey === minuteKey) this.runtime.rateCalls = Number(this.runtime.rateCalls || 0) + 1;
    else this.runtime = { ...(this.runtime || {}), rateMinuteKey: minuteKey, rateCalls: 1 };
    return this.runtime;
  }
  async reconcileBudget({ dayKey, estimatedCostUsd, actualCostUsd, usage }) {
    const row = this.documents.ai_usage_budgets.find((d) => d.dayKey === dayKey);
    row.reservedCostUsd -= estimatedCostUsd; row.costUsd += actualCostUsd;
    row.inputTokens = (row.inputTokens || 0) + (usage.inputTokens || 0);
    row.outputTokens = (row.outputTokens || 0) + (usage.outputTokens || 0);
  }
  async updateRuntime(fields) { this.runtime = { ...(this.runtime || {}), ...fields }; }
  async getRuntime() { return this.runtime; }
}

const COLLECTION_VALIDATOR = Object.freeze({
  $jsonSchema: {
    bsonType: "object",
    required: ["schemaVersion", "createdAt", "canonicalHash"],
    properties: {
      schemaVersion: { bsonType: "string" }, createdAt: { bsonType: "date" }, canonicalHash: { bsonType: "string", pattern: "^[a-f0-9]{64}$" },
    },
  },
});

const INDEXES = Object.freeze({
  ai_signal_events: [[{ signalEventId: 1 }, { unique: true, name: "uniq_signalEventId" }], [{ eventKey: 1 }, { unique: true, sparse: true, name: "uniq_eventKey" }], [{ observedAt: 1 }, { name: "observedAt" }]],
  ai_signal_trade_links: [[{ signalEventId: 1, linkVersion: 1 }, { unique: true, name: "uniq_signal_link_version" }], [{ tradeId: 1 }, { sparse: true, name: "tradeId" }]],
  ai_market_snapshots: [[{ snapshotId: 1 }, { unique: true, name: "uniq_snapshotId" }], [{ signalEventId: 1, snapshotType: 1 }, { unique: true, name: "uniq_event_snapshot_type" }]],
  ai_market_charts: [[{ snapshotId: 1, timeframe: 1 }, { unique: true, name: "uniq_snapshot_timeframe" }]],
  ai_blind_assessments: [[{ signalEventId: 1, promptVersion: 1 }, { unique: true, name: "uniq_blind_version" }]],
  ai_signal_comparisons: [[{ signalEventId: 1, promptVersion: 1 }, { unique: true, name: "uniq_comparison_version" }], [{ createdAt: -1 }, { name: "createdAt" }]],
  ai_outcome_reviews: [[{ tradeId: 1, promptVersion: 1 }, { unique: true, name: "uniq_outcome_version" }], [{ createdAt: -1 }, { name: "createdAt" }]],
  ai_analysis_runs: [[{ runId: 1 }, { unique: true, name: "uniq_runId" }], [{ signalEventId: 1, stage: 1, createdAt: -1 }, { name: "event_stage" }], [{ createdAt: -1 }, { name: "createdAt" }]],
  ai_usage_budgets: [[{ dayKey: 1 }, { unique: true, name: "uniq_dayKey" }]],
  ai_analyst_runtime: [[{ runtimeKey: 1 }, { unique: true, name: "uniq_runtimeKey" }]],
});

class AiCollectionValidationError extends Error {
  constructor(report) {
    super("AI analyst collection preflight failed; no migration changes were applied");
    this.name = "AiCollectionValidationError";
    this.report = report;
  }
}

async function duplicateGroupsForSpec(collection, keys, options) {
  if (!options?.unique) return [];
  const fields = Object.keys(keys);
  const match = options.sparse
    ? Object.fromEntries(fields.map((field) => [field, { $exists: true }]))
    : {};
  return collection.aggregate([
    { $match: match },
    { $group: { _id: Object.fromEntries(fields.map((field) => [field, `$${field}`])), count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 },
  ]).toArray();
}

async function inspectOrMigrateAiCollections(db, { apply = false } = {}) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name));
  const report = { apply, safe: true, collections: [] };
  for (const name of ALL_COLLECTIONS) {
    const row = { name, exists: existing.has(name), count: 0, indexes: [], violations: [], action: apply ? "UNCHANGED" : "PREFLIGHT" };
    if (row.exists) {
      const collection = db.collection(name);
      row.count = await collection.countDocuments({});
      row.indexes = (await collection.indexes()).map((index) => index.name);
      if (IMMUTABLE_COLLECTIONS.includes(name)) {
        const missingIntegrity = await collection.countDocuments({
          $or: [
            { schemaVersion: { $exists: false } },
            { createdAt: { $not: { $type: "date" } } },
            { canonicalHash: { $not: { $type: "string" } } },
          ],
        });
        if (missingIntegrity) row.violations.push({ type: "MISSING_INTEGRITY_FIELDS", count: missingIntegrity });
      }
      for (const [keys, options] of INDEXES[name] || []) {
        const duplicates = await duplicateGroupsForSpec(collection, keys, options);
        if (duplicates.length) row.violations.push({ type: "DUPLICATE_UNIQUE_KEY", index: options.name, groups: duplicates });
      }
    }
    report.collections.push(row);
  }
  report.safe = report.collections.every((row) => row.violations.length === 0);
  if (apply && !report.safe) throw new AiCollectionValidationError(report);
  if (apply) {
    for (const row of report.collections) {
      const name = row.name;
      if (!row.exists) {
        await db.createCollection(name, IMMUTABLE_COLLECTIONS.includes(name) ? { validator: COLLECTION_VALIDATOR, validationLevel: "strict", validationAction: "error" } : {});
        row.exists = true; row.action = "CREATED";
      } else if (IMMUTABLE_COLLECTIONS.includes(name)) {
        await db.command({ collMod: name, validator: COLLECTION_VALIDATOR, validationLevel: "strict", validationAction: "error" });
        row.action = "VALIDATOR_APPLIED";
      }
      for (const [keys, options] of INDEXES[name] || []) await db.collection(name).createIndex(keys, options);
      row.indexes = (await db.collection(name).indexes()).map((index) => index.name);
    }
  }
  return report;
}

module.exports = {
  AiCollectionValidationError, ALL_COLLECTIONS, IMMUTABLE_COLLECTIONS, INDEXES, MemoryAiAnalystRepository,
  MongoAiAnalystRepository, OPERATIONAL_COLLECTIONS, duplicateKey, inspectOrMigrateAiCollections,
};
