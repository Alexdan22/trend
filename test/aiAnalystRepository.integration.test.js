const test = require("node:test");
const assert = require("node:assert/strict");

const { MongoMemoryServer } = require("mongodb-memory-server");
const { Binary, MongoClient, ObjectId } = require("mongodb");

const { canonicalJson, sha256 } = require("../services/aiAnalyst/canonical");
const {
  AiCollectionValidationError, AiDocumentValidationError, IMMUTABLE_COLLECTIONS,
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
      eventKey: undefined,
      nested: {
        occurredAt, bytes: nestedBytes, binary: nestedBinary, omitted: undefined,
        deeper: { kept: "yes", omitted: undefined }, values: [{ kept: 1, omitted: undefined }, undefined],
      },
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
  assert.equal(Object.hasOwn(documents[0][2], "eventKey"), true);
  assert.equal(Object.hasOwn(documents[0][2].nested, "omitted"), true);
  assert.equal(Object.hasOwn(storedEvent, "eventKey"), false);
  assert.equal(Object.hasOwn(storedEvent.nested, "omitted"), false);
  assert.equal(Object.hasOwn(storedEvent.nested.deeper, "omitted"), false);
  assert.equal(Object.hasOwn(storedEvent.nested.values[0], "omitted"), false);
  assert.equal(storedEvent.nested.values[1], null);

  const storedChart = await db.collection("ai_market_charts").findOne({ snapshotId: "snapshot-integration" });
  assert.deepEqual(binaryBuffer(storedChart.png), chartPng);
  assert.equal(storedChart.pngSha256, sha256(chartPng));

  const secondWithoutKey = await repository.insertSignalEvent(Object.freeze({
    schemaVersion: "schema-v1", signalEventId: "signal-without-key-2", eventType: "SIGNAL",
    eventKey: undefined, observedAt: new Date("2026-07-18T10:00:00Z"), symbol: "XAUUSDm", sessionLabel: "LONDON_WINDOW",
  }));
  const noKeyEvents = await db.collection("ai_signal_events").find({ signalEventId: { $in: ["signal-integration", "signal-without-key-2"] } }).toArray();
  assert.equal(noKeyEvents.length, 2);
  assert.ok(noKeyEvents.every((event) => !Object.hasOwn(event, "eventKey")));
  assert.equal(Object.hasOwn(secondWithoutKey, "eventKey"), false);
  assert.ok(noKeyEvents.every((event) => sha256(canonicalJson(event)) === event.canonicalHash));

  const validKey = "CONTROL:XAUUSDm:1784304000000";
  await repository.insertSignalEvent(Object.freeze({
    schemaVersion: "schema-v1", signalEventId: "control-valid-key-1", eventType: "CONTROL",
    eventKey: validKey, observedAt: new Date("2026-07-18T10:30:00Z"), symbol: "XAUUSDm", sessionLabel: "LONDON_WINDOW",
  }));
  await assert.rejects(
    repository.insertSignalEvent(Object.freeze({
      schemaVersion: "schema-v1", signalEventId: "control-valid-key-2", eventType: "CONTROL",
      eventKey: validKey, observedAt: new Date("2026-07-18T11:00:00Z"), symbol: "XAUUSDm", sessionLabel: "LONDON_WINDOW",
    })),
    (error) => error?.code === 11000,
  );

  for (const [label, eventKey] of [["null", null], ["empty", ""], ["invalid", "not valid?"]]) {
    await assert.rejects(
      repository.insertSignalEvent(Object.freeze({
        schemaVersion: "schema-v1", signalEventId: `invalid-${label}`, eventType: "SIGNAL",
        eventKey, observedAt: new Date("2026-07-18T12:00:00Z"), symbol: "XAUUSDm", sessionLabel: "LONDON_WINDOW",
      })),
      (error) => error instanceof AiDocumentValidationError && error.field === "eventKey",
    );
  }
  for (const [label, eventKey] of [["null", null], ["empty", ""]]) {
    await assert.rejects(
      db.collection("ai_signal_events").insertOne({
        schemaVersion: "schema-v1", signalEventId: `direct-invalid-${label}`, eventType: "SIGNAL",
        eventKey, createdAt: new Date(), canonicalHash: "a".repeat(64),
      }),
      (error) => error?.code === 121,
    );
  }
  const eventKeyIndex = (await db.collection("ai_signal_events").indexes()).find((index) => index.name === "uniq_eventKey");
  assert.equal(eventKeyIndex.sparse, undefined);
  assert.deepEqual(eventKeyIndex.partialFilterExpression, { eventKey: { $type: "string" } });

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

  const legacyDb = client.db("ai-analyst-legacy-event-key-test");
  await legacyDb.createCollection("ai_signal_events");
  await legacyDb.collection("ai_signal_events").createIndex({ eventKey: 1 }, { unique: true, sparse: true, name: "uniq_eventKey" });
  await legacyDb.collection("ai_signal_events").insertOne({
    schemaVersion: "schema-v1", signalEventId: "legacy-null-key", eventType: "SIGNAL", eventKey: null,
    createdAt: new Date(), canonicalHash: "a".repeat(64),
  });
  const legacyPreflight = await inspectOrMigrateAiCollections(legacyDb, { apply: false });
  const legacyRow = legacyPreflight.collections.find((row) => row.name === "ai_signal_events");
  assert.equal(legacyPreflight.safe, false);
  assert.ok(legacyRow.violations.some((violation) => violation.type === "INVALID_EVENT_KEY" && violation.count === 1));
  assert.deepEqual(legacyRow.indexReplacements, ["uniq_eventKey"]);
  await assert.rejects(
    inspectOrMigrateAiCollections(legacyDb, { apply: true }),
    (error) => error instanceof AiCollectionValidationError,
  );
  const unchangedLegacyIndex = (await legacyDb.collection("ai_signal_events").indexes()).find((index) => index.name === "uniq_eventKey");
  assert.equal(unchangedLegacyIndex.sparse, true);
  assert.equal(unchangedLegacyIndex.partialFilterExpression, undefined);
});
