require("dotenv").config();

const { connectDB } = require("../db");
const { inspectOrMigrateAiCollections } = require("../services/aiAnalyst/repository");

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply && !process.argv.includes("--confirm=CREATE_AI_COLLECTIONS")) {
    throw new Error("Applying AI collection migration requires --confirm=CREATE_AI_COLLECTIONS");
  }
  const db = await connectDB();
  const report = await inspectOrMigrateAiCollections(db, { apply });
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`[AI MIGRATION] ${error.message || error}`);
  if (error.report) console.error(JSON.stringify(error.report, null, 2));
  process.exit(1);
});
