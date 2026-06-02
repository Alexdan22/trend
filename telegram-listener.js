require("dotenv").config();

const { initTelegramBot, getBot } = require("./telegram");

process.on("unhandledRejection", (error) => {
  console.warn("[TELEGRAM] Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("[TELEGRAM] Uncaught exception:", error);
  process.exit(1);
});

async function startTelegramListener() {
  await initTelegramBot({ polling: true, commands: true });
  console.log("[TELEGRAM] Command listener ready");
}

async function stopTelegramListener(signal) {
  console.log(`[TELEGRAM] ${signal} received, stopping command listener...`);

  try {
    await getBot().stopPolling();
  } catch (error) {
    console.warn("[TELEGRAM] stopPolling failed:", error.message || error);
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => stopTelegramListener("SIGINT"));
process.once("SIGTERM", () => stopTelegramListener("SIGTERM"));

startTelegramListener().catch((error) => {
  console.error("[TELEGRAM] Command listener failed:", error);
  process.exit(1);
});
