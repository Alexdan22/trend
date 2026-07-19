#!/usr/bin/env node

require("dotenv").config();

const { MongoClient } = require("mongodb");
const {
  TradeIdIndexValidationError,
  migrateTradeIdIndexes,
} = require("../services/tradeIdIndex");

const APPLY_CONFIRMATION = "CREATE_UNIQUE_TRADE_ID_INDEXES";

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main() {
  if (!process.env.MONGODB_URI || !process.env.MONGODB_DB_NAME) {
    throw new Error("MONGODB_URI or MONGODB_DB_NAME missing in env");
  }

  const apply = hasFlag("apply");
  if (apply && argValue("confirm") !== APPLY_CONFIRMATION) {
    throw new Error(
      `--apply requires --confirm=${APPLY_CONFIRMATION}`,
    );
  }

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
  });
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DB_NAME);
    const report = await migrateTradeIdIndexes(db, { apply });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  if (error instanceof TradeIdIndexValidationError) {
    console.error(JSON.stringify(error.report, null, 2));
  } else {
    console.error(error.stack || error.message);
  }
  process.exit(1);
});
