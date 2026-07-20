const { IndependentAiMarketAnalyst } = require("./analyst");
const crypto = require("crypto");
const { loadAiAnalystConfig } = require("./config");
const { MongoAiAnalystRepository } = require("./repository");

let analyst = null;

function instance() {
  if (!analyst) {
    const repository = new MongoAiAnalystRepository(() => require("../../db").getDB());
    analyst = new IndependentAiMarketAnalyst({ config: loadAiAnalystConfig(), repository });
  }
  return analyst;
}

function configureAiAnalyst({ notify } = {}) {
  try {
    const current = instance();
    if (notify) current.notify = notify;
    return current.status();
  } catch (error) {
    console.warn(`[AI ANALYST] Initialization disabled: ${error.message || error}`);
    return { mode: "OFF", operational: false, initializationFailed: true };
  }
}

function safe(action, fallback) {
  try { return action(); } catch (error) {
    console.warn(`[AI ANALYST] Observational hook isolated: ${error.message || error}`);
    return typeof fallback === "function" ? fallback() : fallback;
  }
}

function ingestAiTick(tick) { return safe(() => instance().ingestTick(tick), false); }
function warmupAiCandles(fetchCandles, symbol, cutoff) { return safe(() => instance().warmup(fetchCandles, symbol, cutoff), false); }
function captureAiSignal(event) {
  return safe(
    () => instance().captureSignal(event),
    () => Object.freeze({ signalEventId: `signal-${crypto.randomUUID()}`, queued: false }),
  );
}
function recordAiSignalDisposition(event) { return safe(() => instance().recordDisposition(event), false); }
function linkAiSignalTrade(event) { return safe(() => instance().linkTrade(event), false); }
function observeAiExit(event) { return safe(() => instance().observeExit(event), false); }
function maybeCaptureAiControl(event) { return safe(() => instance().maybeCaptureControl(event), false); }
function getAiAnalystStatus() { return safe(() => instance().status(), { mode: "OFF", operational: false }); }

module.exports = {
  captureAiSignal, configureAiAnalyst, getAiAnalystStatus, ingestAiTick,
  linkAiSignalTrade, maybeCaptureAiControl, observeAiExit, recordAiSignalDisposition,
  warmupAiCandles,
};
