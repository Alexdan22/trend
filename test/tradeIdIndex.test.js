const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TradeIdIndexValidationError,
  UNIQUE_INDEX_NAME,
  migrateTradeIdIndexes,
  validateTradeIdCollection,
} = require("../services/tradeIdIndex");

class FakeCollection {
  constructor(name, documents, indexes = [{ name: "_id_", key: { _id: 1 } }]) {
    this.collectionName = name;
    this.documents = documents;
    this.indexList = indexes;
    this.created = [];
  }

  async countDocuments(query) {
    if (!Object.keys(query).length) return this.documents.length;
    return this.documents.filter(
      (document) =>
        !Object.prototype.hasOwnProperty.call(document, "tradeId") ||
        document.tradeId == null ||
        document.tradeId === "",
    ).length;
  }

  aggregate() {
    const counts = new Map();
    for (const document of this.documents) {
      if (document.tradeId == null || document.tradeId === "") continue;
      counts.set(document.tradeId, (counts.get(document.tradeId) || 0) + 1);
    }
    const rows = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tradeId, count]) => ({ tradeId, count }));
    return { toArray: async () => rows };
  }

  async indexes() {
    return this.indexList;
  }

  async createIndex(key, options) {
    this.created.push({ key, options });
    return options.name;
  }
}

class FakeDb {
  constructor(collections) {
    this.collections = collections;
  }

  collection(name) {
    return this.collections[name];
  }
}

function cleanDb() {
  return new FakeDb({
    trades: new FakeCollection("trades", [
      { tradeId: "live-1" },
      { tradeId: "live-2" },
    ]),
    shadow_trades: new FakeCollection("shadow_trades", [
      { tradeId: "shadow-1" },
    ]),
  });
}

test("validation detects duplicate and missing trade IDs", async () => {
  const collection = new FakeCollection("trades", [
    { tradeId: "duplicate" },
    { tradeId: "duplicate" },
    {},
  ]);

  const validation = await validateTradeIdCollection(collection);
  assert.equal(validation.total, 3);
  assert.equal(validation.missingTradeId, 1);
  assert.deepEqual(validation.duplicateGroups, [
    { tradeId: "duplicate", count: 2 },
  ]);
  assert.equal(validation.safeToCreate, false);
});

test("migration fails closed before creating any index when one collection is unsafe", async () => {
  const db = cleanDb();
  db.collections.trades.documents.push({ tradeId: "live-1" });

  await assert.rejects(
    migrateTradeIdIndexes(db, { apply: true }),
    (error) =>
      error instanceof TradeIdIndexValidationError &&
      error.report.validations[0].duplicateGroups.length === 1,
  );

  assert.equal(db.collections.trades.created.length, 0);
  assert.equal(db.collections.shadow_trades.created.length, 0);
});

test("validate-only mode performs no writes", async () => {
  const db = cleanDb();
  const report = await migrateTradeIdIndexes(db, { apply: false });

  assert.equal(report.mode, "VALIDATE_ONLY");
  assert.deepEqual(report.applied, []);
  assert.equal(db.collections.trades.created.length, 0);
  assert.equal(db.collections.shadow_trades.created.length, 0);
});

test("apply mode creates full unique tradeId indexes after all validation passes", async () => {
  const db = cleanDb();
  const report = await migrateTradeIdIndexes(db, { apply: true });

  assert.deepEqual(report.applied, [
    { collection: "trades", name: UNIQUE_INDEX_NAME },
    { collection: "shadow_trades", name: UNIQUE_INDEX_NAME },
  ]);
  for (const collection of Object.values(db.collections)) {
    assert.deepEqual(collection.created, [
      {
        key: { tradeId: 1 },
        options: { unique: true, name: UNIQUE_INDEX_NAME },
      },
    ]);
  }
});

test("an existing full unique index is accepted without recreation", async () => {
  const unique = [
    { name: "_id_", key: { _id: 1 } },
    { name: UNIQUE_INDEX_NAME, key: { tradeId: 1 }, unique: true },
  ];
  const db = new FakeDb({
    trades: new FakeCollection("trades", [{ tradeId: "live-1" }], unique),
    shadow_trades: new FakeCollection(
      "shadow_trades",
      [{ tradeId: "shadow-1" }],
      unique,
    ),
  });

  const report = await migrateTradeIdIndexes(db, { apply: true });
  assert.deepEqual(report.applied, []);
  assert.equal(db.collections.trades.created.length, 0);
  assert.equal(db.collections.shadow_trades.created.length, 0);
});
