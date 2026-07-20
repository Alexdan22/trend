const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AiCollectionValidationError, ALL_COLLECTIONS, IMMUTABLE_COLLECTIONS,
  inspectOrMigrateAiCollections, validEventKey,
} = require("../services/aiAnalyst/repository");

class FakeCollection {
  constructor({ documents = [], duplicateGroups = [], indexes = null } = {}) {
    this.documents = documents;
    this.duplicateGroups = duplicateGroups;
    this.indexRows = indexes || [{ name: "_id_", key: { _id: 1 } }];
    this.createIndexCalls = [];
    this.dropIndexCalls = [];
  }
  async countDocuments(query = {}) {
    if (JSON.stringify(query).includes('"$type":"missing"')) {
      throw new Error("'missing' is not a legal MongoDB type name");
    }
    if (query.eventKey?.$not) {
      return this.documents.filter((document) => Object.hasOwn(document, "eventKey") && !validEventKey(document.eventKey)).length;
    }
    if (!query.$or) return this.documents.length;
    return this.documents.filter((document) => !document.schemaVersion || !(document.createdAt instanceof Date) || typeof document.canonicalHash !== "string").length;
  }
  async indexes() { return this.indexRows; }
  aggregate() { return { toArray: async () => this.duplicateGroups }; }
  async createIndex(keys, options) {
    this.createIndexCalls.push(options.name);
    const existing = this.indexRows.findIndex((index) => index.name === options.name);
    const row = { key: keys, ...options };
    if (existing >= 0) this.indexRows[existing] = row;
    else this.indexRows.push(row);
    return options.name;
  }
  async dropIndex(name) {
    this.dropIndexCalls.push(name);
    this.indexRows = this.indexRows.filter((index) => index.name !== name);
  }
}

class FakeDb {
  constructor(initial = {}) {
    this.collections = new Map(Object.entries(initial));
    this.createCalls = [];
    this.commands = [];
  }
  listCollections() { return { toArray: async () => [...this.collections.keys()].map((name) => ({ name })) }; }
  collection(name) { return this.collections.get(name); }
  async createCollection(name, options) {
    this.createCalls.push({ name, options });
    this.collections.set(name, new FakeCollection());
  }
  async command(command) { this.commands.push(command); }
}

test("AI migration creates only isolated collections, validators and declared indexes", async () => {
  const db = new FakeDb();
  const report = await inspectOrMigrateAiCollections(db, { apply: true });
  assert.equal(report.safe, true);
  assert.deepEqual(db.createCalls.map((call) => call.name), [...ALL_COLLECTIONS]);
  for (const call of db.createCalls.filter((row) => IMMUTABLE_COLLECTIONS.includes(row.name))) {
    assert.equal(call.options.validationLevel, "strict");
    assert.ok(call.options.validator.$jsonSchema);
  }
  assert.ok(db.collection("ai_signal_events").createIndexCalls.includes("uniq_signalEventId"));
  const eventKeyIndex = db.collection("ai_signal_events").indexRows.find((index) => index.name === "uniq_eventKey");
  assert.equal(eventKeyIndex.sparse, undefined);
  assert.deepEqual(eventKeyIndex.partialFilterExpression, { eventKey: { $type: "string" } });
  assert.equal(db.collections.has("trades"), false);
  assert.equal(db.collections.has("shadow_trades"), false);
});

test("AI migration fails closed before any write when existing data is unsafe", async () => {
  const unsafe = new FakeCollection({ documents: [{ signalEventId: "missing-integrity" }] });
  const db = new FakeDb({ ai_signal_events: unsafe });
  await assert.rejects(
    inspectOrMigrateAiCollections(db, { apply: true }),
    (error) => error instanceof AiCollectionValidationError && error.report.safe === false,
  );
  assert.equal(db.createCalls.length, 0);
  assert.equal(db.commands.length, 0);
  assert.equal(unsafe.createIndexCalls.length, 0);
});

test("AI migration preflight is read-only", async () => {
  const db = new FakeDb();
  const report = await inspectOrMigrateAiCollections(db, { apply: false });
  assert.equal(report.apply, false);
  assert.equal(db.createCalls.length, 0);
  assert.equal(db.commands.length, 0);
});

test("AI migration replaces only the known legacy sparse eventKey index after validation", async () => {
  const events = new FakeCollection({
    indexes: [
      { name: "_id_", key: { _id: 1 } },
      { name: "uniq_eventKey", key: { eventKey: 1 }, unique: true, sparse: true },
    ],
  });
  const db = new FakeDb({ ai_signal_events: events });
  const preflight = await inspectOrMigrateAiCollections(db, { apply: false });
  const row = preflight.collections.find((collection) => collection.name === "ai_signal_events");
  assert.equal(preflight.safe, true);
  assert.deepEqual(row.indexReplacements, ["uniq_eventKey"]);
  assert.equal(events.dropIndexCalls.length, 0);

  await inspectOrMigrateAiCollections(db, { apply: true });
  assert.deepEqual(events.dropIndexCalls, ["uniq_eventKey"]);
  const replacement = events.indexRows.find((index) => index.name === "uniq_eventKey");
  assert.equal(replacement.sparse, undefined);
  assert.deepEqual(replacement.partialFilterExpression, { eventKey: { $type: "string" } });
});

test("AI migration refuses index replacement while an invalid explicit eventKey exists", async () => {
  const events = new FakeCollection({
    documents: [{ schemaVersion: "v1", createdAt: new Date(), canonicalHash: "a".repeat(64), eventKey: null }],
    indexes: [
      { name: "_id_", key: { _id: 1 } },
      { name: "uniq_eventKey", key: { eventKey: 1 }, unique: true, sparse: true },
    ],
  });
  const db = new FakeDb({ ai_signal_events: events });
  await assert.rejects(
    inspectOrMigrateAiCollections(db, { apply: true }),
    (error) => error instanceof AiCollectionValidationError
      && error.report.collections.find((row) => row.name === "ai_signal_events").violations.some((violation) => violation.type === "INVALID_EVENT_KEY"),
  );
  assert.equal(events.dropIndexCalls.length, 0);
  assert.equal(events.createIndexCalls.length, 0);
  assert.equal(db.commands.length, 0);
});
