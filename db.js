const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;

if (!uri || !dbName) {
  throw new Error("MONGODB_URI or MONGODB_DB_NAME missing in env");
}

const client = new MongoClient(uri, {
  maxPoolSize: 10
});

let db;

async function connectDB() {
  if (db) return db;

  await client.connect();
  db = client.db(dbName);

  console.log("[DB] MongoDB connected");
  return db;
}

function getDB() {
  if (!db) {
    throw new Error("DB not initialized. Call connectDB() first.");
  }
  return db;
}

module.exports = { connectDB, getDB };
