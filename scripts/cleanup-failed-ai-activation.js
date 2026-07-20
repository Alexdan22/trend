require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EJSON } = require("bson");
const { MongoClient, ObjectId } = require("mongodb");
const { canonicalJson, sha256 } = require(path.join(process.cwd(), "services/aiAnalyst/canonical"));

const CONFIRMATION = "--confirm=DELETE_FAILED_AI_ACTIVATION_24";
const BACKUP_ROOT = "/home/alex/secure-backups/ai-analyst-rollout";

const LIVE_SIGNAL = "signal-5333fa08-30b5-4660-90ec-cc3878d5474f";
const LIVE_TRADE = "pair-1784304006211";
const SHADOW_SIGNAL = "signal-5daa366b-9e26-4de5-816f-7182018d267d";
const SHADOW_TRADE = "shadow-1784517000948";

const manifest = Object.freeze({
  ai_signal_events: [
    { id: "6a5dc499046b047f30b7a644", hash: "4318237d722002e1d1efe8c158d73841bd064b91648f460a3980a1b0c4e5a1b0", recomputedHash: "97683cf8704d40eda4b80889ce15ba5fc96f28926935744bcfdb93e96a592f5e", signalEventId: LIVE_SIGNAL, match: { eventType: "SIGNAL", eventKey: null } },
  ],
  ai_signal_trade_links: [
    { id: "6a5dc4a0046b047f30b7a64c", hash: "005f1961fa1d7845cdf8b19b8ae997d02fab96baaeed0d4d54217dc32f2be980", signalEventId: LIVE_SIGNAL, match: { tradeId: LIVE_TRADE, linkType: "TRADE_LINK" } },
    { id: "6a5dc4f64bbf904d5ab753c7", hash: "ad302907153f4be6072243bbf06bdb5fa1e1787d2901b1d604ce34a4578a4a13", signalEventId: SHADOW_SIGNAL, match: { tradeId: SHADOW_TRADE, linkType: "TRADE_LINK" } },
  ],
  ai_market_snapshots: [
    { id: "6a5dc499046b047f30b7a645", hash: "c6fa1858c89e02055952bb2bbb19d9634bbc729c9cd41e0ffaacbc040be88c78", signalEventId: LIVE_SIGNAL, match: { snapshotId: "snapshot-b3637162-36fc-4a48-8d49-f0e1fb145f79", snapshotType: "SIGNAL" } },
    { id: "6a5dc4aa046b047f30b7a64f", hash: "1c716e6ee88e4e6ceda70a468c71170ddb7f9eb8ba28d78243a7a583597b0bed", signalEventId: LIVE_SIGNAL, match: { snapshotId: "snapshot-07e349a2-ff55-410d-a558-f325636866c7", snapshotType: "EXIT", tradeId: LIVE_TRADE } },
    { id: "6a5dc4f94bbf904d5ab753c9", hash: "bc76a31c5ed2ff8b8df60bf9602780222c34223c3079dd4762fd6febb762b1c9", signalEventId: SHADOW_SIGNAL, match: { snapshotId: "snapshot-16f7e24f-2436-49ad-9578-c074d2449ef0", snapshotType: "EXIT", tradeId: SHADOW_TRADE } },
  ],
  ai_market_charts: [
    { id: "6a5dc499046b047f30b7a646", hash: "3a804b1768599da048bda3b3884492ea7da0481e73f896188a81f4a5040bac9f", signalEventId: LIVE_SIGNAL, match: { snapshotId: "snapshot-b3637162-36fc-4a48-8d49-f0e1fb145f79", snapshotType: "SIGNAL", timeframe: "m30" } },
    { id: "6a5dc499046b047f30b7a647", hash: "baaad6fcb0f1bf0c3e330895a40eed3669a819699ba5b1f2765fb6e860163846", signalEventId: LIVE_SIGNAL, match: { snapshotId: "snapshot-b3637162-36fc-4a48-8d49-f0e1fb145f79", snapshotType: "SIGNAL", timeframe: "m5" } },
    { id: "6a5dc499046b047f30b7a648", hash: "c2d71d969488f2635480296324ae48ed4a85f86decf18efc631ae20ee923ef37", signalEventId: LIVE_SIGNAL, match: { snapshotId: "snapshot-b3637162-36fc-4a48-8d49-f0e1fb145f79", snapshotType: "SIGNAL", timeframe: "m1" } },
    { id: "6a5dc4aa046b047f30b7a650", hash: "e88b0bf9c7df0f89ad0ba0926cde450f7518fc07ea3e288634a3411875704521", signalEventId: LIVE_SIGNAL, match: { snapshotId: "snapshot-07e349a2-ff55-410d-a558-f325636866c7", snapshotType: "EXIT", timeframe: "m30" } },
    { id: "6a5dc4aa046b047f30b7a651", hash: "fa88d094581bfbedeff4177b1651bb09bc48220771b86f76cf9a8f6ec31a861a", signalEventId: LIVE_SIGNAL, match: { snapshotId: "snapshot-07e349a2-ff55-410d-a558-f325636866c7", snapshotType: "EXIT", timeframe: "m5" } },
    { id: "6a5dc4aa046b047f30b7a652", hash: "b21d83b95d3bd30914929eceefb4eb0da70d509f062b77ffe2812cea8408267a", signalEventId: LIVE_SIGNAL, match: { snapshotId: "snapshot-07e349a2-ff55-410d-a558-f325636866c7", snapshotType: "EXIT", timeframe: "m1" } },
    { id: "6a5dc4f94bbf904d5ab753ca", hash: "4edaa82c91ba5211ad622170c3fde828ef25da658384e468244ec1f679d9504e", signalEventId: SHADOW_SIGNAL, match: { snapshotId: "snapshot-16f7e24f-2436-49ad-9578-c074d2449ef0", snapshotType: "EXIT", timeframe: "m30" } },
    { id: "6a5dc4f94bbf904d5ab753cb", hash: "f9452e3f891bae565cfa41a5719b12e636b7777105b938f7e233b1c1422167df", signalEventId: SHADOW_SIGNAL, match: { snapshotId: "snapshot-16f7e24f-2436-49ad-9578-c074d2449ef0", snapshotType: "EXIT", timeframe: "m5" } },
    { id: "6a5dc4f94bbf904d5ab753cc", hash: "1f2ec0af51ed5f4de5aaabc4c27a2b566afb13f7e8f498340509471a9e207279", signalEventId: SHADOW_SIGNAL, match: { snapshotId: "snapshot-16f7e24f-2436-49ad-9578-c074d2449ef0", snapshotType: "EXIT", timeframe: "m1" } },
  ],
  ai_blind_assessments: [
    { id: "6a5dc4a0046b047f30b7a64b", hash: "c96566e7ec362c02dca6f8697d99f2f68c19bdca988e01e13e9e7b0b775bc60f", signalEventId: LIVE_SIGNAL, match: { snapshotId: "snapshot-b3637162-36fc-4a48-8d49-f0e1fb145f79" } },
  ],
  ai_signal_comparisons: [
    { id: "6a5dc4a7046b047f30b7a64e", hash: "aabdccbe089129cbda6d959428d72d2157c6471602e26fdd42c912a2a4de5491", signalEventId: LIVE_SIGNAL, match: { tradeId: LIVE_TRADE } },
  ],
  ai_outcome_reviews: [
    { id: "6a5dc4b0046b047f30b7a654", hash: "2a7cf14384ab5636039273967d60744a8eb2a30e8f293cc4a1567025541bcb81", signalEventId: LIVE_SIGNAL, match: { tradeId: LIVE_TRADE, snapshotId: "snapshot-07e349a2-ff55-410d-a558-f325636866c7" } },
  ],
  ai_analysis_runs: [
    { id: "6a5dc4a0046b047f30b7a64a", hash: "2122c249506ec647b3f23f04129e201b82b96e1a03fbf69ab129a4a8dffcc80a", signalEventId: LIVE_SIGNAL, match: { runId: "airun-d7e057ed-68cc-4341-ac62-ddb6be3846b5", stage: "BLIND" } },
    { id: "6a5dc4a7046b047f30b7a64d", hash: "c865183a93e440cffeeb7f75043712766974e7e5bb03204411cd7498b676e15b", signalEventId: LIVE_SIGNAL, match: { runId: "airun-07431d38-c3fd-4061-b8dd-a57b5a64e924", stage: "COMPARISON", tradeId: LIVE_TRADE } },
    { id: "6a5dc4b0046b047f30b7a653", hash: "40fb4be0f049b236b570b33664fd06a687d39af8dffcc16bdd3cff10c2d380f8", signalEventId: LIVE_SIGNAL, match: { runId: "airun-2fbe9d69-8e68-4b34-b9ee-ac5d75ab7228", stage: "OUTCOME", tradeId: LIVE_TRADE } },
    { id: "6a5dc4f64bbf904d5ab753c6", hash: "8455abf4f82f6a921b847d57151e31a7e861f6cab4f507074ce38fb1c3961826", signalEventId: SHADOW_SIGNAL, match: { runId: "airun-40b1ec95-1486-4f99-b005-e23378946a05", stage: "SIGNAL", status: "PERSISTENCE_ERROR" } },
    { id: "6a5dc4f64bbf904d5ab753c8", hash: "239f3399a4ea7fa6f2e95682f8c4be9c0c16bba5e42f130f7f0311e911651d9b", signalEventId: SHADOW_SIGNAL, match: { runId: "airun-5e402b0a-18a4-4272-881d-3932de7bec09", stage: "COMPARISON", status: "PREREQUISITE_MISSING", tradeId: SHADOW_TRADE } },
    { id: "6a5dc4f94bbf904d5ab753cd", hash: "f0341fe9c30358c781f13e5bd08c2c9569e54ba8a9f88bbb201faaa7b22c381c", signalEventId: SHADOW_SIGNAL, match: { runId: "airun-dfd41212-7fe3-400c-ac06-1049448a6326", stage: "OUTCOME", status: "PREREQUISITE_MISSING", tradeId: SHADOW_TRADE } },
  ],
});

const IMMUTABLE_COLLECTIONS = Object.freeze(Object.keys(manifest));
const EXPECTED_COUNTS = Object.freeze(Object.fromEntries(IMMUTABLE_COLLECTIONS.map((name) => [name, manifest[name].length])));
const DELETE_ORDER = Object.freeze([
  "ai_market_charts", "ai_outcome_reviews", "ai_signal_comparisons", "ai_blind_assessments",
  "ai_market_snapshots", "ai_signal_trade_links", "ai_analysis_runs", "ai_signal_events",
]);
const OPERATIONAL_TARGETS = Object.freeze({
  ai_usage_budgets: "6a5dc499046b047f30b7a649",
  ai_analyst_runtime: "6a5dbe8114e589df69550a74",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactEjson(value) {
  return EJSON.stringify(value, { relaxed: false });
}

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeBoolean(name) {
  return String(process.env[name] || "").trim().toLowerCase() === "true";
}

function assertDisabledConfiguration() {
  invariant(String(process.env.AI_ANALYST_MODE || "OFF").trim().toUpperCase() === "OFF", "AI_ANALYST_MODE must be OFF");
  for (const name of ["AI_ANALYST_SIGNALS_ENABLED", "AI_ANALYST_CONTROLS_ENABLED", "AI_ANALYST_EXITS_ENABLED", "AI_ANALYST_TELEGRAM_ENABLED", "AI_REPORTS_ENABLED"]) {
    invariant(!safeBoolean(name), `${name} must be false`);
  }
}

function tuple(entry) {
  return { _id: new ObjectId(entry.id), canonicalHash: entry.hash, signalEventId: entry.signalEventId, ...entry.match };
}

function verifyDocument(entry, document) {
  invariant(document, `Missing ${entry.id}`);
  invariant(String(document._id) === entry.id, `Unexpected _id for ${entry.id}`);
  invariant(document.canonicalHash === entry.hash, `Stored hash changed for ${entry.id}`);
  invariant(document.signalEventId === entry.signalEventId, `Signal linkage changed for ${entry.id}`);
  for (const [key, value] of Object.entries(entry.match)) {
    invariant(exactEjson(document[key]) === exactEjson(value), `Field ${key} changed for ${entry.id}`);
  }
  const recomputed = sha256(canonicalJson(document));
  invariant(recomputed === (entry.recomputedHash || entry.hash), `Canonical hash precondition failed for ${entry.id}`);
}

async function loadAndVerifyTargets(db, options = {}) {
  const documents = {};
  for (const name of IMMUTABLE_COLLECTIONS) {
    const count = await db.collection(name).countDocuments({}, options);
    invariant(count === EXPECTED_COUNTS[name], `${name} count ${count} != ${EXPECTED_COUNTS[name]}`);
    const ids = manifest[name].map((entry) => new ObjectId(entry.id));
    const found = await db.collection(name).find({ _id: { $in: ids } }, options).sort({ _id: 1 }).toArray();
    invariant(found.length === manifest[name].length, `${name} target count mismatch`);
    const byId = new Map(found.map((document) => [String(document._id), document]));
    for (const entry of manifest[name]) verifyDocument(entry, byId.get(entry.id));
    documents[name] = manifest[name].map((entry) => byId.get(entry.id));
  }
  return documents;
}

async function verifyLegacyIndex(db, options = {}) {
  const indexes = await db.collection("ai_signal_events").indexes(options);
  const index = indexes.find((candidate) => candidate.name === "uniq_eventKey");
  invariant(index, "Legacy uniq_eventKey index is missing");
  invariant(index.unique === true && index.sparse === true, "uniq_eventKey is no longer the reviewed legacy sparse unique index");
  invariant(exactEjson(index.key) === exactEjson({ eventKey: 1 }), "uniq_eventKey key changed");
  invariant(!index.partialFilterExpression, "uniq_eventKey partial migration already applied");
  return index;
}

async function loadOperational(db, options = {}) {
  const result = {};
  for (const [name, id] of Object.entries(OPERATIONAL_TARGETS)) {
    const document = await db.collection(name).findOne({ _id: new ObjectId(id) }, options);
    invariant(document, `Operational record ${name}/${id} missing`);
    result[name] = document;
  }
  return result;
}

async function collectionMetadata(db) {
  const names = [...IMMUTABLE_COLLECTIONS, ...Object.keys(OPERATIONAL_TARGETS)];
  const result = {};
  for (const name of names) {
    const options = await db.listCollections({ name }, { nameOnly: false }).next();
    invariant(options, `Collection metadata missing for ${name}`);
    result[name] = { options, indexes: await db.collection(name).indexes() };
  }
  return result;
}

async function tradingFingerprint(db) {
  const result = {};
  for (const name of ["trades", "shadow_trades"]) {
    const documents = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    result[name] = { count: documents.length, sha256: sha256(exactEjson(documents)) };
  }
  return result;
}

function writeProtectedBackup({ documents, operational, metadata }) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true, mode: 0o700 });
  fs.chmodSync(BACKUP_ROOT, 0o700);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDirectory = path.join(BACKUP_ROOT, `failed-activation-cleanup-${timestamp}`);
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);
  const payloads = {
    "immutable-artifacts.extjson": { format: "MongoDB Extended JSON", relaxed: false, createdAt: new Date(), totalDocuments: 24, collections: documents },
    "operational-context.extjson": { format: "MongoDB Extended JSON", relaxed: false, createdAt: new Date(), collections: operational },
    "collection-metadata.extjson": { format: "MongoDB Extended JSON", relaxed: false, createdAt: new Date(), collections: metadata },
  };
  const hashes = {};
  for (const [fileName, payload] of Object.entries(payloads)) {
    const filePath = path.join(backupDirectory, fileName);
    fs.writeFileSync(filePath, `${exactEjson(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(filePath, 0o600);
    hashes[fileName] = fileSha256(filePath);
    const parsed = EJSON.parse(fs.readFileSync(filePath, "utf8"), { relaxed: false });
    invariant(parsed.format === payload.format, `Backup parse failed for ${fileName}`);
  }
  const checksumPath = path.join(backupDirectory, "SHA256SUMS");
  const checksumText = Object.entries(hashes).map(([fileName, hash]) => `${hash}  ${fileName}`).join("\n") + "\n";
  fs.writeFileSync(checksumPath, checksumText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.chmodSync(checksumPath, 0o600);
  for (const [fileName, hash] of Object.entries(hashes)) invariant(fileSha256(path.join(backupDirectory, fileName)) === hash, `Backup SHA-256 verification failed for ${fileName}`);

  const restored = EJSON.parse(fs.readFileSync(path.join(backupDirectory, "immutable-artifacts.extjson"), "utf8"), { relaxed: false });
  invariant(Number(restored.totalDocuments) === 24, "Backup total document count mismatch");
  for (const name of IMMUTABLE_COLLECTIONS) {
    invariant(restored.collections[name].length === EXPECTED_COUNTS[name], `Backup ${name} count mismatch`);
    const ids = restored.collections[name].map((document) => String(document._id)).sort();
    invariant(exactEjson(ids) === exactEjson(manifest[name].map((entry) => entry.id).sort()), `Backup ${name} IDs mismatch`);
  }
  return { backupDirectory, hashes };
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply) invariant(process.argv.includes(CONFIRMATION), `Apply requires ${CONFIRMATION}`);
  assertDisabledConfiguration();
  invariant(process.env.MONGODB_URI && process.env.MONGODB_DB_NAME, "MongoDB configuration is missing");

  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DB_NAME);
    await db.command({ ping: 1 });
    await verifyLegacyIndex(db);
    const documents = await loadAndVerifyTargets(db);
    const operational = await loadOperational(db);
    const operationalFingerprint = sha256(exactEjson(operational));
    const tradingBefore = await tradingFingerprint(db);

    if (!apply) {
      console.log(JSON.stringify({ ok: true, mode: "PREFLIGHT", targetedDocuments: 24, expectedCounts: EXPECTED_COUNTS, legacyEventKeyIndex: true, operationalRecordsRetained: 2, tradingCollections: Object.fromEntries(Object.entries(tradingBefore).map(([name, value]) => [name, { count: value.count }])) }, null, 2));
      return;
    }

    const backup = writeProtectedBackup({ documents, operational, metadata: await collectionMetadata(db) });
    const session = client.startSession();
    const deletedCounts = {};
    try {
      await session.withTransaction(async () => {
        await loadAndVerifyTargets(db, { session });
        const transactionOperational = await loadOperational(db, { session });
        invariant(sha256(exactEjson(transactionOperational)) === operationalFingerprint, "Operational records changed before deletion");

        for (const name of DELETE_ORDER) {
          const result = await db.collection(name).deleteMany({ $or: manifest[name].map(tuple) }, { session });
          invariant(result.acknowledged === true, `${name} deletion was not acknowledged`);
          invariant(result.deletedCount === EXPECTED_COUNTS[name], `${name} deletedCount ${result.deletedCount} != ${EXPECTED_COUNTS[name]}`);
          deletedCounts[name] = result.deletedCount;
        }
        invariant(Object.values(deletedCounts).reduce((sum, value) => sum + value, 0) === 24, "Transactional deleted total is not 24");
        for (const name of IMMUTABLE_COLLECTIONS) invariant(await db.collection(name).countDocuments({}, { session }) === 0, `${name} is not empty before commit`);
        const retained = await loadOperational(db, { session });
        invariant(sha256(exactEjson(retained)) === operationalFingerprint, "Operational records changed during deletion");
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
    } finally {
      await session.endSession();
    }

    for (const name of IMMUTABLE_COLLECTIONS) invariant(await db.collection(name).countDocuments({}) === 0, `${name} has residual documents after commit`);
    const retainedAfter = await loadOperational(db);
    invariant(sha256(exactEjson(retainedAfter)) === operationalFingerprint, "Operational records changed after commit");
    const tradingAfter = await tradingFingerprint(db);
    invariant(exactEjson(tradingAfter) === exactEjson(tradingBefore), "Trading collections changed across cleanup");

    console.log(JSON.stringify({
      ok: true,
      mode: "APPLIED",
      backupDirectory: backup.backupDirectory,
      backupSha256: backup.hashes,
      deletedCounts,
      deletedTotal: 24,
      immutableArtifactsRemaining: 0,
      operationalRecordsRetained: Object.keys(OPERATIONAL_TARGETS).length,
      tradingCollectionsUnchanged: true,
      tradingCollections: Object.fromEntries(Object.entries(tradingAfter).map(([name, value]) => [name, { count: value.count }])),
    }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`[AI CLEANUP] ${error.message || error}`);
  process.exitCode = 1;
});
