const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AiCollectionValidationError, ALL_COLLECTIONS, IMMUTABLE_COLLECTIONS,
  inspectOrMigrateAiCollections,
} = require("../services/aiAnalyst/repository");

class FakeCollection {
  constructor({ documents = [], duplicateGroups = [] } = {}) {
    this.documents = documents;
    this.duplicateGroups = duplicateGroups;
    this.indexRows = [{ name: "_id_" }];
    this.createIndexCalls = [];
  }
  async countDocuments(query = {}) {
    if (!query.$or) return this.documents.length;
    return this.documents.filter((document) => !document.schemaVersion || !(document.createdAt instanceof Date) || typeof document.canonicalHash !== "string").length;
  }
  async indexes() { return this.indexRows; }
  aggregate() { return { toArray: async () => this.duplicateGroups }; }
  async createIndex(_keys, options) { this.createIndexCalls.push(options.name); this.indexRows.push({ name: options.name }); return options.name; }
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
