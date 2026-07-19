const TRADE_COLLECTIONS = Object.freeze(["trades", "shadow_trades"]);
const UNIQUE_INDEX_NAME = "uniq_tradeId";

class TradeIdIndexValidationError extends Error {
  constructor(report) {
    super("Cannot create unique tradeId indexes: validation failed");
    this.name = "TradeIdIndexValidationError";
    this.report = report;
  }
}

async function validateTradeIdCollection(collection) {
  const [total, missingTradeId, duplicateGroups, indexes] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments({
      $or: [
        { tradeId: { $exists: false } },
        { tradeId: null },
        { tradeId: "" },
      ],
    }),
    collection
      .aggregate([
        { $match: { tradeId: { $exists: true, $nin: [null, ""] } } },
        { $group: { _id: "$tradeId", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $project: { _id: 0, tradeId: "$_id", count: 1 } },
        { $sort: { tradeId: 1 } },
      ])
      .toArray(),
    collection.indexes(),
  ]);

  const tradeIdIndexes = indexes.filter(
    (index) =>
      index.key &&
      Object.keys(index.key).length === 1 &&
      Number(index.key.tradeId) === 1,
  );
  const uniqueIndexPresent = tradeIdIndexes.some(
    (index) =>
      index.unique &&
      !index.sparse &&
      !index.partialFilterExpression,
  );
  const conflictingNonUniqueIndex = tradeIdIndexes.find(
    (index) =>
      !index.unique || index.sparse || index.partialFilterExpression,
  );

  return {
    collection: collection.collectionName,
    total,
    missingTradeId,
    duplicateGroups,
    uniqueIndexPresent,
    conflictingNonUniqueIndex: conflictingNonUniqueIndex?.name || null,
    safeToCreate:
      missingTradeId === 0 &&
      duplicateGroups.length === 0 &&
      !conflictingNonUniqueIndex,
  };
}

async function migrateTradeIdIndexes(db, { apply = false } = {}) {
  const validations = [];
  for (const collectionName of TRADE_COLLECTIONS) {
    validations.push(
      await validateTradeIdCollection(db.collection(collectionName)),
    );
  }

  const report = {
    mode: apply ? "APPLY" : "VALIDATE_ONLY",
    validatedAt: new Date().toISOString(),
    validations,
    applied: [],
  };
  const unsafe = validations.filter(
    (validation) =>
      !validation.safeToCreate && !validation.uniqueIndexPresent,
  );
  if (unsafe.length) throw new TradeIdIndexValidationError(report);
  if (!apply) return report;

  for (const validation of validations) {
    if (validation.uniqueIndexPresent) continue;
    const collection = db.collection(validation.collection);
    const name = await collection.createIndex(
      { tradeId: 1 },
      { unique: true, name: UNIQUE_INDEX_NAME },
    );
    report.applied.push({ collection: validation.collection, name });
  }

  return report;
}

module.exports = {
  TRADE_COLLECTIONS,
  TradeIdIndexValidationError,
  UNIQUE_INDEX_NAME,
  migrateTradeIdIndexes,
  validateTradeIdCollection,
};
