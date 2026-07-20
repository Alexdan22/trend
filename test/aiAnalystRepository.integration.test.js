const test = require("node:test");
const assert = require("node:assert/strict");

const { MongoMemoryServer } = require("mongodb-memory-server");
const { Binary, MongoClient, ObjectId } = require("mongodb");

const { canonicalJson, sha256 } = require("../services/aiAnalyst/canonical");
const {
  IMMUTABLE_COLLECTIONS,
  MongoAiAnalystRepository,
  inspectOrMigrateAiCollections,
} = require("../services/aiAnalyst/repository");

function binaryBuffer(value) {
  assert.ok(value instanceof Binary);
  return Buffer.from(value.buffer).subarray(0, value.position);
}

test("Mongo repository inserts immutable artifacts through mutable top-level copies", async (t) => {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri());
  await client.connect();
  const db = client.db("ai-analyst-repository-test");
  t.after(async () => {
    await client.close();
    await server.stop();
  });

  const migration = await inspectOrMigrateAiCollections(db, { apply: true });
  assert.equal(migration.safe, true);

  const driverInsertions = [];
  const repositoryDb = {
    collection(name) {
      const collection = db.collection(name);
      return new Proxy(collection, {
        get(target, property) {
          if (property === "insertOne") {
            return async (document, options) => {
              const before = canonicalJson(document);
              const mutableBeforeInsert = Object.isExtensible(document);
              const result = await collection.insertOne(document, options);
              driverInsertions.push({
                name,
                document,
                before,
                mutableBeforeInsert,
                insertedId: result.insertedId,
              });
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const repository = new MongoAiAnalystRepository(() => repositoryDb);

  const occurredAt = new Date("2026-07-17T16:00:06.696Z");
  const nestedBytes = Buffer.from([0, 1, 2, 127, 255]);
  const nestedBinary = new Binary(Buffer.from("nested-bson"));
  const chartPng = Buffer.from("\x89PNG\r\n\x1a\nchart-bytes", "binary");
  const documents = [
    ["ai_signal_events", "insertSignalEvent", {
      schemaVersion: "schema-v1", signalEventId: "signal-integration", eventType: "SIGNAL",
      observedAt: occurredAt, symbol: "XAUUSDm", sessionLabel: "NY_WINDOW",
      nested: { occurredAt, bytes: nestedBytes, binary: nestedBinary },
    }],
    ["ai_signal_trade_links", "insertSignalTradeLink", {
      schemaVersion: "schema-v1", signalEventId: "signal-integration", linkVersion: 1,
      linkType: "TRADE_LINK", disposition: "LIVE_CREATED", tradeId: "pair-integration",
    }],
    ["ai_market_snapshots", "insertMarketSnapshot", {
      schemaVersion: "schema-v1", snapshotId: "snapshot-integration", signalEventId: "signal-integration",
      snapshotType: "SIGNAL", observedAt: occurredAt, market: { timestamp: occurredAt }, candles: { m30: [] },
    }],
    ["ai_market_charts", "insertMarketChart", {
      schemaVersion: "schema-v1", snapshotId: "snapshot-integration", signalEventId: "signal-integration",
      snapshotType: "SIGNAL", timeframe: "m30", width: 1024, height: 576, png: chartPng,
    }],
    ["ai_blind_assessments", "insertBlindAssessment", {
      schemaVersion: "schema-v1", promptVersion: "prompt-v1", signalEventId: "signal-integration",
      snapshotId: "snapshot-integration", correlationId: "correlation-integration", assessment: { action: "WAIT" },
    }],
    ["ai_signal_comparisons", "insertSignalComparison", {
      schemaVersion: "schema-v1", promptVersion: "prompt-v1", signalEventId: "signal-integration",
      tradeId: "pair-integration", blindAssessmentHash: "a".repeat(64), comparison: { grade: "C" },
    }],
    ["ai_outcome_reviews", "insertOutcomeReview", {
      schemaVersion: "schema-v1", promptVersion: "prompt-v1", signalEventId: "signal-integration",
      tradeId: "pair-integration", snapshotId: "snapshot-exit-integration", originalGrade: "C", review: { result: "WIN" },
    }],
    ["ai_analysis_runs", "insertAnalysisRun", {
      schemaVersion: "schema-v1", promptVersion: "prompt-v1", runId: "run-integration",
      signalEventId: "signal-integration", stage: "BLIND", status: "SUCCEEDED", model: "test-model", store: false,
    }],
  ];

  const returnedByCollection = new Map();
  for (const [collectionName, method, input] of documents) {
    const frozenInput = Object.freeze(input);
    const inputBefore = canonicalJson(frozenInput);
    const persisted = await repository[method](frozenInput);
    returnedByCollection.set(collectionName, persisted);

    assert.ok(Object.isFrozen(frozenInput), `${method} input stays frozen`);
    assert.equal(canonicalJson(frozenInput), inputBefore, `${method} input stays unchanged`);
    assert.ok(Object.isFrozen(persisted), `${method} returns the frozen canonical artifact`);
    assert.equal(Object.hasOwn(persisted, "_id"), false, `${method} does not add MongoDB _id to the artifact`);
    assert.equal(sha256(canonicalJson(persisted)), persisted.canonicalHash, `${method} canonical hash is stable`);
  }

  assert.deepEqual(driverInsertions.map(({ name }) => name).sort(), [...IMMUTABLE_COLLECTIONS].sort());
  assert.equal(driverInsertions.length, IMMUTABLE_COLLECTIONS.length);
  for (const insertion of driverInsertions) {
    const persisted = returnedByCollection.get(insertion.name);
    assert.equal(insertion.mutableBeforeInsert, true, `${insertion.name} receives a mutable insertion copy`);
    assert.notEqual(insertion.document, persisted, `${insertion.name} does not pass the frozen artifact to MongoDB`);
    assert.ok(insertion.insertedId instanceof ObjectId, `${insertion.name} captures a driver-generated insertedId`);
    assert.ok(insertion.document._id.equals(insertion.insertedId), `${insertion.name} lets the driver add _id to its copy`);
    assert.equal(insertion.before, canonicalJson(persisted), `${insertion.name} insertion copy preserves canonical content`);

    const stored = await db.collection(insertion.name).findOne({ _id: insertion.insertedId });
    assert.ok(stored);
    assert.equal(stored.canonicalHash, persisted.canonicalHash);
    assert.equal(sha256(canonicalJson(stored)), stored.canonicalHash, `${insertion.name} hash survives BSON round-trip`);
  }

  const storedEvent = await db.collection("ai_signal_events").findOne({ signalEventId: "signal-integration" });
  assert.ok(storedEvent.observedAt instanceof Date);
  assert.equal(storedEvent.observedAt.toISOString(), occurredAt.toISOString());
  assert.ok(storedEvent.nested.occurredAt instanceof Date);
  assert.equal(storedEvent.nested.occurredAt.toISOString(), occurredAt.toISOString());
  assert.deepEqual(binaryBuffer(storedEvent.nested.bytes), nestedBytes);
  assert.deepEqual(binaryBuffer(storedEvent.nested.binary), Buffer.from("nested-bson"));

  const storedChart = await db.collection("ai_market_charts").findOne({ snapshotId: "snapshot-integration" });
  assert.deepEqual(binaryBuffer(storedChart.png), chartPng);
  assert.equal(storedChart.pngSha256, sha256(chartPng));

  const duplicateInput = Object.freeze({
    schemaVersion: "schema-v1", signalEventId: "signal-integration", eventType: "SIGNAL",
    observedAt: new Date("2026-07-18T16:00:00Z"), symbol: "XAUUSDm", sessionLabel: "NY_WINDOW",
  });
  const duplicateBefore = canonicalJson(duplicateInput);
  await assert.rejects(
    repository.insertSignalEvent(duplicateInput),
    (error) => error?.code === 11000,
  );
  assert.ok(Object.isFrozen(duplicateInput));
  assert.equal(canonicalJson(duplicateInput), duplicateBefore);
  assert.equal(await db.collection("ai_signal_events").countDocuments({ signalEventId: "signal-integration" }), 1);
});
