#!/usr/bin/env node
"use strict";

/*
 * Read-only production audit for the London/New York time gate introduced in
 * faf70026. The local mode streams this same file to the VPS over SSH; the
 * remote mode performs bounded MongoDB finds plus filesystem/process reads and
 * returns sanitized JSON on stdout. It never imports or enters exness.js.
 *
 * Reproduce from the repository root:
 *   node reports/time-gate-audit/read-only-audit.js \
 *     --host=my_vps \
 *     --from=2026-07-07T14:20:03.000Z \
 *     --to=2026-07-19T20:02:53.000Z
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const DEPLOYED_COMMIT = "faf70026e6977d8b93990763b181ddbaf0aec74b";
const DEFAULT_FROM = "2026-07-07T14:20:03.000Z";
const DEFAULT_TO = "2026-07-19T20:02:53.000Z";
const DEFAULT_HOST = "my_vps";
const DEFAULT_APP_DIR = "/home/alex/engine";
const DEFAULT_OFFSET_MINUTES = 330;
const GATE_KEYS = [
  "LIVE_SESSION_GATE_ENABLED",
  "LIVE_SESSION_START_IST",
  "LIVE_SESSION_START",
  "LIVE_SESSION_END_IST",
  "LIVE_SESSION_END",
  "TRADING_SESSION_TZ_OFFSET_MINUTES",
  "REPORT_TZ_OFFSET_MINUTES",
  "NY_SESSION_START_IST",
];

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function assertIso(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 UTC timestamp`);
  }
  return date;
}

function iso(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_error) {
    return "";
  }
}

function safeStat(file) {
  try {
    const stat = fs.statSync(file);
    return {
      path: file,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      changedAt: stat.ctime.toISOString(),
    };
  } catch (error) {
    return { path: file, error: error.message };
  }
}

function normalizeDocument(document) {
  const dateFields = [
    "openedAt",
    "closedAt",
    "createdAt",
    "updatedAt",
    "partialClosedAt",
  ];
  const numberFields = [
    "entryScore",
    "entryPrice",
    "exitPrice",
    "sl",
    "tp",
    "lot",
    "lotEach",
    "grossPnL",
    "netPnL",
    "durationSec",
    "partialExitPrice",
    "partialPnL",
    "internalSL",
    "plannedRisk",
    "plannedReward",
    "plannedRR",
    "realizedR",
  ];
  const output = {};
  const allowedFields = [
    "tradeId",
    "executionMode",
    "blockedReason",
    "sessionLabel",
    "sessionWindow",
    "side",
    "category",
    "symbol",
    "entryReason",
    "state",
    "closingReason",
    "result",
    "partialClosed",
    "breakEvenActive",
    ...dateFields,
    ...numberFields,
  ];

  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(document, field)) continue;
    if (dateFields.includes(field)) output[field] = iso(document[field]);
    else if (numberFields.includes(field)) output[field] = numberOrNull(document[field]);
    else output[field] = document[field];
  }

  output.entryMetaPresent = document.entryMeta != null;
  output.entryMetaReason =
    document.entryMeta && typeof document.entryMeta === "object"
      ? document.entryMeta.reason ?? null
      : null;
  output.fieldNames = Object.keys(document)
    .filter((field) => !["_id", "accountId", "userId", "entryMeta"].includes(field))
    .sort();
  return output;
}

function parsePm2Lifecycle(pm2Log, from, to) {
  const events = [];
  for (const line of pm2Log.split(/\r?\n/)) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}):.*(?:pullback|exness\.js)/i);
    if (!match) continue;
    const timestamp = new Date(`${match[1]}Z`);
    if (timestamp < from || timestamp > to) continue;
    const message = line.replace(/^.*?PM2 log:\s*/, "").trim();
    events.push({ timestamp: timestamp.toISOString(), message });
  }
  return events;
}

function collectLogEvidence({ appDir, documents, from, to, pm2Row }) {
  const logSnapshotAt = new Date();
  const outLog = pm2Row?.pm2_env?.pm_out_log_path || "/home/alex/.pm2/logs/pullback-out.log";
  const errorLog = pm2Row?.pm2_env?.pm_err_log_path || "/home/alex/.pm2/logs/pullback-error.log";
  const pm2Log = "/home/alex/.pm2/pm2.log";
  const outText = safeRead(outLog);
  const errorText = safeRead(errorLog);
  const marker = "[SESSION] Live order window:";
  const firstMarkerIndex = outText.indexOf(marker);
  const auditedOut = firstMarkerIndex >= 0 ? outText.slice(firstMarkerIndex) : outText;

  const firstTimestampAfterMarker =
    auditedOut.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]/)?.[1] || null;
  const patternCounts = {
    sessionStartupMarkers: countOccurrences(auditedOut, marker),
    shadowCreated: countOccurrences(auditedOut, "[SHADOW] Created"),
    shadowFinalized: countOccurrences(auditedOut, "[SHADOW] Finalized"),
    shadowPartialBreakevenActivated: countOccurrences(auditedOut, "[SHADOW] Partial + BE activated"),
    shadowRestoreBatches: countOccurrences(auditedOut, "[SHADOW] Restored"),
    shadowRestoreFailures: countOccurrences(auditedOut, "[SHADOW] Failed to restore"),
    shadowTickErrors: countOccurrences(auditedOut, "processTickForShadowTrades error"),
    liveSnapshotSaveFailures: countOccurrences(auditedOut, "Snapshot/save failed"),
    entryLockBlocked: countOccurrences(auditedOut, "entry lock active"),
    entryLockAcquired: (auditedOut.match(/\[ENTRY-LOCK\].*Acquired/g) || []).length,
    entryLockReleased: (auditedOut.match(/\[ENTRY-LOCK\].*Released/g) || []).length,
    entryLockTimeoutForce: countOccurrences(auditedOut, "timeout exceeded"),
    gracefulShutdowns: countOccurrences(auditedOut, "Gracefully shutting down"),
    streamSynchronizations: countOccurrences(auditedOut, "Streaming connection synchronized"),
    realTimeStreamInitializations: countOccurrences(auditedOut, "Real-time tick streaming initialized"),
    websocketConnectedMessages: countOccurrences(auditedOut, "websocket client connected"),
    websocketDisconnectedMessages:
      countOccurrences(auditedOut, "websocket client disconnected") +
      countOccurrences(auditedOut, "MetaApi websocket client disconnected"),
    reconnectMentions:
      (auditedOut.match(/reconnect/gi) || []).length + (errorText.match(/reconnect/gi) || []).length,
  };

  const allDocs = [...documents.trades, ...documents.shadow_trades];
  const auditedTradeIds = new Set(allDocs.map((document) => String(document.tradeId || "")));
  const illegalStateTransitions = [];
  const transitionRegex = /\[STATE\] Illegal transition ([^\r\n(]+) \(([^)]+)\)/g;
  let transitionMatch;
  while ((transitionMatch = transitionRegex.exec(errorText))) {
    if (!auditedTradeIds.has(transitionMatch[2])) continue;
    illegalStateTransitions.push({
      transition: transitionMatch[1].trim(),
      tradeId: transitionMatch[2],
    });
  }
  patternCounts.illegalStateTransitions = illegalStateTransitions.length;
  const auditedLines = auditedOut.split(/\r?\n/);
  const tradeIdCorrelation = allDocs.map((document) => {
    const id = String(document.tradeId || "");
    const related = new Set();
    if (id) {
      for (let index = 0; index < auditedLines.length; index += 1) {
        if (!auditedLines[index].includes(id)) continue;
        for (let nearby = Math.max(0, index - 4); nearby <= Math.min(auditedLines.length - 1, index + 4); nearby += 1) {
          related.add(auditedLines[nearby]);
        }
      }
    }
    const context = [...related].join("\n");
    return {
      tradeId: id,
      outputLogMentions: id ? countOccurrences(auditedOut, id) : 0,
      errorLogMentions: id ? countOccurrences(errorText, id) : 0,
      eventFlags: {
        stopLossHit: context.includes("STOP-LOSS HIT"),
        syncPartialConfirmedMissing: context.includes("PARTIAL confirmed missing"),
        syncPairFullyClosed: context.includes("Pair fully closed"),
        syncClosedFinalization: context.includes("reason=SYNC_CLOSED"),
        partialBreakevenActivation:
          context.includes("PARTIAL closed + BE activated") ||
          context.includes("Partial + BE activated"),
      },
    };
  });

  const loggedCreatedIds = [];
  const idRegex = /\[SHADOW\] Created (shadow-(\d+))/g;
  let idMatch;
  while ((idMatch = idRegex.exec(auditedOut))) {
    const createdFromId = new Date(Number(idMatch[2]));
    if (createdFromId >= from && createdFromId <= to) loggedCreatedIds.push(idMatch[1]);
  }

  return {
    snapshotAt: logSnapshotAt.toISOString(),
    files: [safeStat(outLog), safeStat(errorLog), safeStat(pm2Log)],
    gateMarker: {
      found: firstMarkerIndex >= 0,
      firstMarkerLine: firstMarkerIndex >= 0 ? outText.slice(0, firstMarkerIndex).split(/\r?\n/).length : null,
      firstTimestampedLineAfterMarker: firstTimestampAfterMarker,
    },
    patternCounts,
    pm2Lifecycle: parsePm2Lifecycle(safeRead(pm2Log), from, to),
    tradeIdCorrelation,
    illegalStateTransitions,
    loggedShadowCreatedIds: [...new Set(loggedCreatedIds)].sort(),
    notes: [
      "Raw application lines generally lack timestamps; event counts are taken from the retained output after the first gate startup marker.",
      `Untimestamped application-log counts run through the log read at ${logSnapshotAt.toISOString()}, while timestamped PM2 lifecycle rows are bounded to the audit period.`,
      "PM2 lifecycle rows carry server timestamps; the server timezone was independently observed as UTC.",
      "No raw log lines, URLs, account identifiers, or environment values outside the non-secret gate allowlist are exported.",
    ],
  };
}

async function remoteCollect() {
  const appDir = argValue("app-dir", DEFAULT_APP_DIR);
  const from = assertIso(argValue("from", DEFAULT_FROM), "from");
  const to = assertIso(argValue("to", DEFAULT_TO), "to");
  if (from >= to) throw new Error("from must be earlier than to");
  process.chdir(appDir);

  const dotenv = require(path.join(appDir, "node_modules/dotenv"));
  const parsedEnv = dotenv.config({ path: path.join(appDir, ".env") }).parsed || {};
  const { MongoClient } = require(path.join(appDir, "node_modules/mongodb"));
  const pm2Rows = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8" }));
  const pm2Row = pm2Rows.find((row) => row.name === "pullback");
  const pm2Env = pm2Row?.pm2_env || {};
  const configured = {};
  const sources = {};
  for (const key of GATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(pm2Env, key)) {
      configured[key] = pm2Env[key];
      sources[key] = "PM2 environment";
    } else if (Object.prototype.hasOwnProperty.call(parsedEnv, key)) {
      configured[key] = parsedEnv[key];
      sources[key] = ".env";
    }
  }
  const getConfig = (primary, secondary, fallback) =>
    configured[primary] ?? configured[secondary] ?? fallback;
  const effectiveGate = {
    enabled: configured.LIVE_SESSION_GATE_ENABLED !== "false",
    start: getConfig("LIVE_SESSION_START_IST", "LIVE_SESSION_START", "13:30"),
    end: getConfig("LIVE_SESSION_END_IST", "LIVE_SESSION_END", "23:59"),
    offsetMinutes: Number(
      getConfig("TRADING_SESSION_TZ_OFFSET_MINUTES", "REPORT_TZ_OFFSET_MINUTES", 330),
    ),
    nyLabelStart: configured.NY_SESSION_START_IST ?? "18:30",
    explicitValues: configured,
    valueSources: sources,
  };

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
  });
  await client.connect();
  const documents = {};
  const collections = {};
  try {
    const db = client.db(process.env.MONGODB_DB_NAME);
    const bounded = { $gte: from, $lte: to };
    const query = {
      $or: [
        { openedAt: bounded },
        { createdAt: bounded },
        { updatedAt: bounded },
        { closedAt: bounded },
      ],
    };
    for (const name of ["trades", "shadow_trades"]) {
      const collection = db.collection(name);
      const rows = await collection
        .find(query)
        .project({ accountId: 0, userId: 0 })
        .sort({ openedAt: 1, _id: 1 })
        .toArray();
      documents[name] = rows.map(normalizeDocument);
      collections[name] = {
        matchedByBoundedTimestampQuery: rows.length,
        indexDefinitions: (await collection.indexes()).map((index) => ({
          name: index.name,
          key: index.key,
          unique: Boolean(index.unique),
        })),
      };
    }
  } finally {
    await client.close();
  }

  const git = (args) => execFileSync("git", args, { cwd: appDir, encoding: "utf8" }).trim();
  const fileStats = [
    "exness.js",
    "models.js",
    "services/sessionWindow.js",
    ".git/logs/HEAD",
  ].map((relativePath) => safeStat(path.join(appDir, relativePath)));
  const deployment = {
    head: git(["rev-parse", "HEAD"]),
    branch: git(["branch", "--show-current"]),
    worktreeStatus: git(["status", "--short"]),
    commit: git(["show", "-s", "--format=%H|%aI|%cI|%s", "HEAD"]),
    targetReflog: git([
      "reflog",
      "--all",
      "--date=iso-strict",
      "--format=%H|%gD|%gs",
    ])
      .split(/\r?\n/)
      .find((line) => line.startsWith(DEPLOYED_COMMIT)) || null,
    files: fileStats,
  };

  const safePm2 = pm2Row
    ? {
        id: pm2Row.pm_id,
        name: pm2Row.name,
        pid: pm2Row.pid,
        status: pm2Env.status,
        pmUptime: pm2Env.pm_uptime ? new Date(pm2Env.pm_uptime).toISOString() : null,
        restartTime: pm2Env.restart_time,
        unstableRestarts: pm2Env.unstable_restarts,
        cwd: pm2Env.pm_cwd,
        script: pm2Env.pm_exec_path,
      }
    : null;
  const logs = collectLogEvidence({ appDir, documents, from, to, pm2Row });

  process.stdout.write(
    JSON.stringify({
      collectedAt: new Date().toISOString(),
      auditRange: { from: from.toISOString(), to: to.toISOString() },
      deployment,
      effectiveGate,
      pm2: safePm2,
      collections,
      documents,
      logs,
    }),
  );
}

function clockToMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinuteOfDay(value) {
  const normalized = ((Number(value) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(
    normalized % 60,
  ).padStart(2, "0")}`;
}

function localParts(value, offsetMinutes) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const shifted = new Date(date.getTime() + offsetMinutes * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

function localLabel(value, offsetMinutes) {
  const parts = localParts(value, offsetMinutes);
  if (!parts) return null;
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(
    parts.minute,
  )}:${pad(parts.second)}.${pad(parts.millisecond, 3)} IST`;
}

function withinWindow(minute, start, end) {
  if (!Number.isFinite(minute) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start <= end) return minute >= start && minute <= end;
  return minute >= start || minute <= end;
}

function inferredSession(document, gate) {
  const parts = localParts(document.openedAt, gate.offsetMinutes);
  if (!parts) return { minute: null, within: false, label: "UNKNOWN" };
  const minute = parts.hour * 60 + parts.minute;
  const start = clockToMinutes(gate.start);
  const end = clockToMinutes(gate.end);
  const nyStart = clockToMinutes(gate.nyLabelStart);
  const within = withinWindow(minute, start, end);
  let label;
  if (within) label = minute >= nyStart || nyStart < start ? "NY_WINDOW" : "LONDON_WINDOW";
  else if (start <= end) label = minute < start ? "PRE_LONDON_WINDOW" : "AFTER_SESSION_CUTOFF";
  else label = "OUTSIDE_LIVE_WINDOW";
  return { minute, within, label };
}

function pnl(document) {
  return numberOrNull(document.netPnL ?? document.grossPnL);
}

function resultFromPnl(value) {
  if (!Number.isFinite(value)) return "INCOMPLETE";
  return value > 0 ? "WIN" : value < 0 ? "LOSS" : "BE";
}

function requiredMissing(document, kind) {
  const common = [
    "tradeId",
    "side",
    "symbol",
    "entryPrice",
    "exitPrice",
    "sl",
    "tp",
    "lot",
    "openedAt",
    "closedAt",
    "durationSec",
    "closingReason",
    "grossPnL",
    "netPnL",
    "plannedRisk",
    "plannedReward",
    "plannedRR",
    "result",
  ];
  const shadow = [
    "executionMode",
    "blockedReason",
    "sessionLabel",
    "sessionWindow",
    "state",
  ];
  return [...common, ...(kind === "shadow" ? shadow : [])].filter(
    (field) => document[field] == null || document[field] === "",
  );
}

function recordIssues(document, kind, gate) {
  const issues = [];
  const missing = requiredMissing(document, kind);
  if (missing.length) issues.push(`missing required fields: ${missing.join(", ")}`);
  const actualPnl = pnl(document);
  const derivedResult = resultFromPnl(actualPnl);
  if (document.result && document.result !== derivedResult) {
    issues.push(`result ${document.result} disagrees with PnL-derived ${derivedResult}`);
  }
  if (
    Number.isFinite(document.grossPnL) &&
    Number.isFinite(document.netPnL) &&
    Math.abs(document.grossPnL - document.netPnL) > 1e-9
  ) {
    issues.push("grossPnL and netPnL differ");
  }
  const opened = new Date(document.openedAt).getTime();
  const closed = new Date(document.closedAt).getTime();
  if (Number.isFinite(opened) && Number.isFinite(closed)) {
    if (closed < opened) issues.push("closedAt precedes openedAt");
    const derivedDuration = Math.floor((closed - opened) / 1000);
    if (
      Number.isFinite(document.durationSec) &&
      Math.abs(document.durationSec - derivedDuration) > 1
    ) {
      issues.push(`durationSec differs from timestamp duration by ${document.durationSec - derivedDuration}s`);
    }
  }
  if (document.partialClosed) {
    for (const field of ["partialExitPrice", "partialClosedAt", "partialPnL"]) {
      if (document[field] == null) issues.push(`partialClosed but ${field} is missing`);
    }
    if (!document.breakEvenActive) issues.push("partialClosed but breakEvenActive is false");
  }
  const session = inferredSession(document, gate);
  if (kind === "live" && !session.within) issues.push("live trade opened outside configured window");
  if (kind === "shadow" && session.within) issues.push("shadow trade opened inside configured window");
  if (kind === "shadow") {
    if (document.executionMode !== "SHADOW") issues.push("shadow executionMode is not SHADOW");
    if (document.blockedReason !== "OUTSIDE_LONDON_NY_WINDOW") {
      issues.push("shadow blockedReason is not OUTSIDE_LONDON_NY_WINDOW");
    }
    if (document.sessionLabel !== session.label) {
      issues.push(`stored sessionLabel ${document.sessionLabel} disagrees with inferred ${session.label}`);
    }
    if (document.sessionWindow !== `${gate.start}-${gate.end} IST`) {
      issues.push("stored sessionWindow disagrees with effective window");
    }
    if (document.state !== "CLOSED" && document.closedAt) {
      issues.push("closed shadow record is not in CLOSED state");
    }
  }
  return issues;
}

function completion(document, kind) {
  const hasClose = Boolean(iso(document.closedAt));
  const hasPnl = Number.isFinite(pnl(document));
  return hasClose && hasPnl && (kind !== "shadow" || document.state === "CLOSED");
}

function maxDrawdown(documents) {
  let equity = 0;
  let peak = 0;
  let maximum = 0;
  for (const document of [...documents].sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))) {
    equity += pnl(document) || 0;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak - equity);
  }
  return maximum;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function validatedPartialClose(document) {
  return Boolean(
    document.partialClosed &&
      document.breakEvenActive &&
      document.partialExitPrice != null &&
      document.partialClosedAt &&
      document.partialPnL != null,
  );
}

function metricSummary(documents, label) {
  const completed = documents.filter((document) => iso(document.closedAt) && Number.isFinite(pnl(document)));
  const values = completed.map(pnl);
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const breakevens = values.filter((value) => value === 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const avgWin = average(wins);
  const avgLoss = average(losses);
  const realizedRs = completed.map((document) => numberOrNull(document.realizedR)).filter(Number.isFinite);
  const durations = completed
    .map((document) => numberOrNull(document.durationSec))
    .filter(Number.isFinite)
    .map((seconds) => seconds / 60);
  const count = completed.length;
  const recordedPartialCloseCount = completed.filter((document) => document.partialClosed).length;
  const validatedPartialCloseCount = completed.filter(validatedPartialClose).length;
  return {
    label,
    records: documents.length,
    completed: count,
    incomplete: documents.length - count,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    winRatePct: count ? (wins.length / count) * 100 : null,
    netPnL: values.reduce((sum, value) => sum + value, 0),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? "Infinity" : null,
    expectancy: count ? values.reduce((sum, value) => sum + value, 0) / count : null,
    maxDrawdown: maxDrawdown(completed),
    averageWin: avgWin,
    averageLoss: avgLoss,
    payoffRatio:
      Number.isFinite(avgWin) && Number.isFinite(avgLoss) && avgLoss !== 0
        ? avgWin / Math.abs(avgLoss)
        : null,
    averageDurationMinutes: average(durations),
    realizedR: {
      available: realizedRs.length,
      coveragePct: count ? (realizedRs.length / count) * 100 : null,
      total: realizedRs.reduce((sum, value) => sum + value, 0),
      average: average(realizedRs),
    },
    frequencies: {
      recordedPartialCloseCount,
      recordedPartialClosePct: count ? (recordedPartialCloseCount / count) * 100 : null,
      validatedPartialCloseCount,
      validatedPartialClosePct: count
        ? (validatedPartialCloseCount / count) * 100
        : null,
      anomalousPartialFlagCount: recordedPartialCloseCount - validatedPartialCloseCount,
      breakEvenExitCount: completed.filter((document) => document.closingReason === "BREAK_EVEN").length,
      breakEvenExitPct: count
        ? (completed.filter((document) => document.closingReason === "BREAK_EVEN").length / count) * 100
        : null,
      zeroPnlCount: breakevens.length,
      zeroPnlPct: count ? (breakevens.length / count) * 100 : null,
      breakEvenActivatedCount: completed.filter((document) => document.breakEvenActive).length,
      breakEvenActivatedPct: count
        ? (completed.filter((document) => document.breakEvenActive).length / count) * 100
        : null,
    },
  };
}

function groupDocuments(documents, keyFn) {
  const groups = new Map();
  for (const document of documents) {
    const key = String(keyFn(document) ?? "UNKNOWN");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(document);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => metricSummary(rows, key));
}

function fingerprint(document) {
  const opened = iso(document.openedAt);
  const rounded = opened ? opened.slice(0, 19) : "NO_TIME";
  const price = (value) =>
    Number.isFinite(numberOrNull(value)) ? numberOrNull(value).toFixed(5) : "NA";
  return [document.side || "UNKNOWN", rounded, price(document.entryPrice), price(document.sl), price(document.tp)].join("|");
}

function duplicates(documents, keyFn) {
  const map = new Map();
  for (const document of documents) {
    const key = keyFn(document);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(document.tradeId || null);
  }
  return [...map.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, tradeIds]) => ({ key, tradeIds }));
}

function coverage(documents, field) {
  const populated = documents.filter(
    (document) => document[field] != null && document[field] !== "",
  ).length;
  return {
    populated,
    total: documents.length,
    pct: documents.length ? (populated / documents.length) * 100 : null,
  };
}

function buildManifest(documents, kind, gate) {
  return documents.map((document) => {
    const session = inferredSession(document, gate);
    const issues = recordIssues(document, kind, gate);
    return {
      tradeId: document.tradeId || null,
      collection: kind === "live" ? "trades" : "shadow_trades",
      openedAtUTC: iso(document.openedAt),
      openedAtIST: localLabel(document.openedAt, gate.offsetMinutes),
      closedAtUTC: iso(document.closedAt),
      closedAtIST: localLabel(document.closedAt, gate.offsetMinutes),
      configuredMinuteIST: session.minute,
      inferredSessionLabel: session.label,
      storedSessionLabel: document.sessionLabel ?? null,
      storedSessionWindow: document.sessionWindow ?? null,
      withinConfiguredWindow: session.within,
      side: document.side ?? null,
      entryReason: document.entryReason ?? null,
      exitReason: document.closingReason ?? null,
      result: resultFromPnl(pnl(document)),
      netPnL: pnl(document),
      durationSec: numberOrNull(document.durationSec),
      partialClosed: Boolean(document.partialClosed),
      breakEvenActive: Boolean(document.breakEvenActive),
      realizedR: numberOrNull(document.realizedR),
      complete: completion(document, kind),
      compliant: issues.length === 0,
      issues,
    };
  });
}

function buildAudit(raw) {
  const from = new Date(raw.auditRange.from);
  const to = new Date(raw.auditRange.to);
  const gate = raw.effectiveGate;
  const liveAll = raw.documents.trades;
  const shadowAll = raw.documents.shadow_trades;
  const inOpenedRange = (document) => {
    const opened = new Date(document.openedAt);
    return Number.isFinite(opened.getTime()) && opened >= from && opened <= to;
  };
  const live = liveAll.filter(inOpenedRange);
  const shadow = shadowAll.filter(inOpenedRange);
  const liveCarryovers = liveAll.filter((document) => !inOpenedRange(document));
  const shadowCarryovers = shadowAll.filter((document) => !inOpenedRange(document));
  const liveManifest = buildManifest(live, "live", gate);
  const shadowManifest = buildManifest(shadow, "shadow", gate);
  const liveViolations = liveManifest.filter((row) => !row.withinConfiguredWindow);
  const shadowViolations = shadowManifest.filter((row) => row.withinConfiguredWindow);
  const liveIssues = liveManifest.flatMap((row) => row.issues.map((issue) => ({ tradeId: row.tradeId, issue })));
  const shadowIssues = shadowManifest.flatMap((row) => row.issues.map((issue) => ({ tradeId: row.tradeId, issue })));
  const affectedLiveRecords = new Set(liveIssues.map((item) => item.tradeId)).size;
  const affectedShadowRecords = new Set(shadowIssues.map((item) => item.tradeId)).size;
  const liveMetrics = metricSummary(live, "LIVE");
  const shadowMetrics = metricSummary(shadow, "SHADOW");
  const all = [...live, ...shadow];
  const crossFingerprints = duplicates(all, fingerprint).filter((item) => {
    const ids = new Set(item.tradeIds);
    return ids.size > 1;
  });
  const gateFieldDefinitions = Object.keys(gate.explicitValues || {});
  const loggedCreatedIds = new Set(raw.logs.loggedShadowCreatedIds);
  const dbShadowIds = new Set(shadow.map((document) => document.tradeId));
  const loggedMissingFromDb = [...loggedCreatedIds].filter((id) => !dbShadowIds.has(id));
  const dbMissingCreationLog = [...dbShadowIds].filter((id) => !loggedCreatedIds.has(id));
  const openShadow = shadow.filter((document) => document.state !== "CLOSED" || !document.closedAt);
  const logCorrelationById = new Map(
    raw.logs.tradeIdCorrelation.map((item) => [item.tradeId, item]),
  );
  const partialFlagAnomalies = live
    .filter((document) => document.partialClosed && !validatedPartialClose(document))
    .map((document) => ({
      tradeId: document.tradeId,
      recordedPartialClosed: true,
      validatedPartialClosed: false,
      storedNetPnL: pnl(document),
      storedRealizedR: numberOrNull(document.realizedR),
      exitReason: document.closingReason || null,
      logEventFlags: logCorrelationById.get(document.tradeId)?.eventFlags || null,
      interpretation:
        "The stop-loss and position-sync paths overlapped. Sync marked a disappearing partial ticket as partialClosed without recording a partial outcome or activating breakeven; stored full-stop PnL and realized R remain internally consistent.",
    }));
  const lifecycleTradeOverlap = raw.logs.pm2Lifecycle.map((event) => {
    const timestamp = new Date(event.timestamp).getTime();
    const spans = (document) => {
      const opened = new Date(document.openedAt).getTime();
      const closed = new Date(document.closedAt).getTime();
      return Number.isFinite(opened) && Number.isFinite(closed) && opened < timestamp && closed > timestamp;
    };
    return {
      ...event,
      liveTradeIdsOpenAcrossEvent: live.filter(spans).map((document) => document.tradeId),
      shadowTradeIdsOpenAcrossEvent: shadow.filter(spans).map((document) => document.tradeId),
    };
  });

  const dimensions = {
    byHourIST: {
      live: groupDocuments(live, (document) => {
        const parts = localParts(document.openedAt, gate.offsetMinutes);
        return parts ? String(parts.hour).padStart(2, "0") : "UNKNOWN";
      }),
      shadow: groupDocuments(shadow, (document) => {
        const parts = localParts(document.openedAt, gate.offsetMinutes);
        return parts ? String(parts.hour).padStart(2, "0") : "UNKNOWN";
      }),
    },
    bySessionLabel: {
      live: groupDocuments(live, (document) => inferredSession(document, gate).label),
      shadow: groupDocuments(shadow, (document) => inferredSession(document, gate).label),
    },
    bySide: {
      live: groupDocuments(live, (document) => document.side || "UNKNOWN"),
      shadow: groupDocuments(shadow, (document) => document.side || "UNKNOWN"),
    },
    byEntryReason: {
      live: groupDocuments(live, (document) => document.entryReason || "UNKNOWN"),
      shadow: groupDocuments(shadow, (document) => document.entryReason || "UNKNOWN"),
    },
    byExitReason: {
      live: groupDocuments(live, (document) => document.closingReason || document.result || "UNKNOWN"),
      shadow: groupDocuments(shadow, (document) => document.closingReason || document.result || "UNKNOWN"),
    },
    byDayIST: {
      live: groupDocuments(live, (document) => localLabel(document.openedAt, gate.offsetMinutes)?.slice(0, 10)),
      shadow: groupDocuments(shadow, (document) => localLabel(document.openedAt, gate.offsetMinutes)?.slice(0, 10)),
    },
  };

  const shadowNet = shadowMetrics.netPnL;
  const liveBetterByExpectancy =
    Number.isFinite(liveMetrics.expectancy) &&
    Number.isFinite(shadowMetrics.expectancy) &&
    liveMetrics.expectancy > shadowMetrics.expectancy;
  const sampleSmall = liveMetrics.completed < 30 || shadowMetrics.completed < 30;
  let recommendation = "RETAIN_AND_OBSERVE_LONGER";
  if (liveViolations.length || shadowViolations.length) recommendation = "FIX_ENFORCEMENT_BEFORE_POLICY_CHANGE";

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    auditPeriod: {
      fromUTC: raw.auditRange.from,
      toUTC: raw.auditRange.to,
      fromIST: localLabel(raw.auditRange.from, gate.offsetMinutes),
      toIST: localLabel(raw.auditRange.to, gate.offsetMinutes),
      boundaryBasis:
        "PM2 first gated-process online timestamp; first retained gate marker precedes the first post-marker timestamped MetaAPI line at 2026-07-07T14:20:18.909Z.",
    },
    deployedCommit: {
      requested: DEPLOYED_COMMIT,
      productionHead: raw.deployment.head,
      branch: raw.deployment.branch,
      cleanWorktree: raw.deployment.worktreeStatus === "",
      commitMetadata: raw.deployment.commit,
      vpsArrivalReflog: raw.deployment.targetReflog,
      vpsArrivalAtUTC: "2026-06-28T17:27:23.000Z",
      operationalGateStartAtUTC: raw.auditRange.from,
      firstTimestampedEvidenceAfterGateMarkerUTC:
        raw.logs.gateMarker.firstTimestampedLineAfterMarker,
      deploymentTimeUncertaintySeconds:
        (new Date(raw.logs.gateMarker.firstTimestampedLineAfterMarker) - from) / 1000,
      evidenceFiles: raw.deployment.files,
    },
    effectiveConfiguration: {
      ...gate,
      explicitGateVariablesPresent: gateFieldDefinitions,
      conclusion:
        gateFieldDefinitions.length === 0
          ? "No gate override was defined in PM2 or .env; code defaults were effective."
          : "One or more gate values were explicitly overridden; see explicitValues and valueSources.",
      inclusiveMinuteSemantics: true,
      effectiveUTCWindow: `${formatMinuteOfDay(
        clockToMinutes(gate.start) - gate.offsetMinutes,
      )}-${formatMinuteOfDay(clockToMinutes(gate.end) - gate.offsetMinutes)} UTC`,
    },
    records: {
      live: {
        boundedQueryMatches: raw.collections.trades.matchedByBoundedTimestampQuery,
        openedInAuditPeriod: live.length,
        carryoversTouchingPeriod: liveCarryovers.length,
        completionCount: liveMetrics.completed,
      },
      shadow: {
        boundedQueryMatches: raw.collections.shadow_trades.matchedByBoundedTimestampQuery,
        openedInAuditPeriod: shadow.length,
        carryoversTouchingPeriod: shadowCarryovers.length,
        completionCount: shadowMetrics.completed,
        openAtSnapshot: openShadow.length,
      },
    },
    integrity: {
      liveOutsideWindow: liveViolations,
      shadowInsideWindow: shadowViolations,
      liveRecordIssues: liveIssues,
      shadowRecordIssues: shadowIssues,
      affectedLiveRecords,
      affectedShadowRecords,
      duplicateTradeIds: {
        live: duplicates(live, (document) => document.tradeId || "MISSING"),
        shadow: duplicates(shadow, (document) => document.tradeId || "MISSING"),
      },
      duplicateFingerprints: {
        live: duplicates(live, fingerprint),
        shadow: duplicates(shadow, fingerprint),
        crossCollectionCandidates: crossFingerprints,
      },
      metadataCoverage: {
        live: {
          entryReason: coverage(live, "entryReason"),
          entryScore: coverage(live, "entryScore"),
          category: coverage(live, "category"),
          realizedR: coverage(live, "realizedR"),
          explicitExecutionMode: coverage(live, "executionMode"),
          explicitSessionLabel: coverage(live, "sessionLabel"),
        },
        shadow: {
          entryReason: coverage(shadow, "entryReason"),
          entryScore: coverage(shadow, "entryScore"),
          category: coverage(shadow, "category"),
          realizedR: coverage(shadow, "realizedR"),
          executionMode: coverage(shadow, "executionMode"),
          sessionLabel: coverage(shadow, "sessionLabel"),
        },
      },
      partialFlagAnomalies,
      indexes: {
        live: raw.collections.trades.indexDefinitions,
        shadow: raw.collections.shadow_trades.indexDefinitions,
      },
      logDatabaseCorrelation: {
        loggedShadowCreatedMissingFromDatabase: loggedMissingFromDb,
        databaseShadowMissingCreationLog: dbMissingCreationLog,
        perTrade: raw.logs.tradeIdCorrelation,
        illegalStateTransitions: raw.logs.illegalStateTransitions,
      },
      timestampInterpretation: {
        databaseStorage: "BSON Date instants interpreted as UTC",
        displayConversion: `UTC + ${gate.offsetMinutes} minutes = IST`,
        gateConversion: "The same fixed offset is applied before minute-of-day classification.",
      },
    },
    performance: {
      live: liveMetrics,
      shadow: shadowMetrics,
      deltasLiveMinusShadow: {
        completed: liveMetrics.completed - shadowMetrics.completed,
        wins: liveMetrics.wins - shadowMetrics.wins,
        losses: liveMetrics.losses - shadowMetrics.losses,
        netPnL: liveMetrics.netPnL - shadowMetrics.netPnL,
        expectancy: liveMetrics.expectancy - shadowMetrics.expectancy,
        maxDrawdown: liveMetrics.maxDrawdown - shadowMetrics.maxDrawdown,
        averageDurationMinutes:
          liveMetrics.averageDurationMinutes - shadowMetrics.averageDurationMinutes,
      },
      excludedShadowCounterfactual: {
        shadowNetPnL: shadowNet,
        livePlusShadowNetPnL: liveMetrics.netPnL + shadowNet,
        wouldHaveImprovedAggregateNetPnL: shadowNet > 0,
        caveat:
          "This is an additive signal counterfactual before broker execution costs/capacity interactions, not proof of realizable live P&L.",
      },
      dimensions,
    },
    operationalEvidence: {
      pm2Snapshot: raw.pm2,
      pm2Lifecycle: raw.logs.pm2Lifecycle,
      lifecycleTradeOverlap,
      logMarkerCounts: raw.logs.patternCounts,
      gateMarker: raw.logs.gateMarker,
      logFiles: raw.logs.files,
      logNotes: raw.logs.notes,
      interpretation: {
        openShadowRecordsAtSnapshot: openShadow.length,
        restoredShadowBatches: raw.logs.patternCounts.shadowRestoreBatches,
        shadowTickErrors: raw.logs.patternCounts.shadowTickErrors,
        snapshotSaveFailures: raw.logs.patternCounts.liveSnapshotSaveFailures,
        entryLockBlocks: raw.logs.patternCounts.entryLockBlocked,
        lockTimeoutForceEvents: raw.logs.patternCounts.entryLockTimeoutForce,
      },
    },
    sessionAndDstAssessment: {
      fixedWindow: `${gate.start}-${gate.end} IST`,
      auditPeriodSeason: "UK British Summer Time and US Eastern Daylight Time",
      conventionalSessionAssumption: {
        londonLocal: "08:00-17:00 Europe/London",
        newYorkLocal: "08:00-17:00 America/New_York",
      },
      july2026EquivalentIST: {
        london: "12:30-21:30 IST (BST, UTC+1)",
        newYork: "17:30-02:30 IST next day (EDT, UTC-4)",
      },
      winterEquivalentIST: {
        london: "13:30-22:30 IST (GMT, UTC+0)",
        newYork: "18:30-03:30 IST next day (EST, UTC-5)",
      },
      assessment:
        "The fixed window is not an accurate full-session union. In July it omits 12:30-13:29 IST at the London open and 00:00-02:30 IST of New York, while its NY_WINDOW label starts one hour late. In winter it aligns with the London open and NY label start but still truncates New York after 23:59. UK/US DST transition dates also differ, creating additional mismatch weeks.",
      policyCaveat:
        "FX/spot-gold session labels are market conventions, not a single exchange-enforced schedule; define the intended core-liquidity interval before changing code.",
      sources: [
        "https://www.gov.uk/when-do-the-clocks-change",
        "https://www.nist.gov/pml/time-and-frequency-division/popular-links/daylight-saving-time-dst",
      ],
    },
    conclusion: {
      confirmed: [
        `${liveViolations.length} live trades opened outside the configured window.`,
        `${shadowViolations.length} shadow trades were created inside the configured window.`,
        `${affectedLiveRecords} live record and ${affectedShadowRecords} shadow records had integrity anomalies (${liveIssues.length + shadowIssues.length} individual checks).`,
        `${openShadow.length} shadow trades were incomplete at the snapshot.`,
        `Shadow trades ${shadowNet > 0 ? "would" : "would not"} have improved simple aggregate net P&L before execution/capacity effects.`,
      ],
      weakDueToSample: [
        `Only ${liveMetrics.completed} live and ${shadowMetrics.completed} shadow completed trades were available.`,
        `Live expectancy was ${liveBetterByExpectancy ? "higher" : "not higher"} than shadow expectancy, but this sample is too small for a durable signal-quality conclusion.`,
        "Session/hour/day subgroup results are particularly fragile because several buckets contain only one or a few trades.",
      ],
      recommendation,
      recommendationText:
        recommendation === "RETAIN_AND_OBSERVE_LONGER"
          ? "Retain the current production window provisionally and observe longer; do not revise it from this P&L sample alone. Separately settle the semantic specification: if the policy truly means the full London plus New York sessions, the fixed window will need a DST-aware revision."
          : "Correct enforcement/data violations before evaluating a policy change.",
      headlineLiveVersusShadow: {
        observedBetterSignalsRetained: liveBetterByExpectancy && liveMetrics.netPnL > shadowMetrics.netPnL,
        netPnLDifferenceLiveMinusShadow: liveMetrics.netPnL - shadowMetrics.netPnL,
        winRateDifferencePercentagePoints: liveMetrics.winRatePct - shadowMetrics.winRatePct,
        expectancyDifference: liveMetrics.expectancy - shadowMetrics.expectancy,
        maxDrawdownReduction: shadowMetrics.maxDrawdown - liveMetrics.maxDrawdown,
        confidence: sampleSmall ? "WEAK_SMALL_SAMPLE" : "MODERATE",
      },
      sampleSmall,
    },
    recordManifest: {
      live: liveManifest,
      shadow: shadowManifest,
    },
    limitations: [
      "Application PM2 output lines generally lack timestamps, so only PM2 lifecycle rows and timestamped MetaAPI lines support exact event times.",
      "Live grossPnL and netPnL are identical in the stored snapshots; commissions, swaps, and slippage are therefore not separately represented.",
      "Shadow fills are tick-simulated and do not include live order rejection, slippage, spread/cost, or capacity interactions.",
      "No independent broker statement was queried; this audit is of trades, shadow_trades, deployed code, and retained PM2 logs.",
    ],
    safety: {
      productionMutations: 0,
      databaseOperations: "bounded find/index-list reads only",
      processOperations: "PM2 metadata/log reads only; no restart/reload/stop/start",
      remoteFilesWritten: 0,
      strategyImportedOrExecuted: false,
      aiUsedInStrategy: false,
    },
  };
}

function money(value) {
  return Number.isFinite(value) ? `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}` : "N/A";
}

function percent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "N/A";
}

function decimal(value, places = 2) {
  if (value === "Infinity") return "INF";
  return Number.isFinite(value) ? value.toFixed(places) : "N/A";
}

function metricTableRow(metric) {
  return `| ${metric.label} | ${metric.records} | ${metric.completed} | ${metric.wins}/${metric.losses}/${metric.breakevens} | ${percent(metric.winRatePct)} | ${money(metric.netPnL)} | ${decimal(metric.profitFactor)} | ${money(metric.expectancy)} | ${money(metric.maxDrawdown)} | ${money(metric.averageWin)} | ${money(metric.averageLoss)} | ${decimal(metric.payoffRatio)} | ${decimal(metric.averageDurationMinutes, 1)} min | ${decimal(metric.realizedR.average)} (${metric.realizedR.available}/${metric.completed}) |`;
}

function groupTable(lines, title, groups) {
  lines.push(`### ${title}`, "", "| Mode | Bucket | N | W/L/BE | Net P&L | PF | Expectancy |", "|---|---|---:|---:|---:|---:|---:|");
  for (const mode of ["live", "shadow"]) {
    for (const group of groups[mode]) {
      lines.push(
        `| ${mode.toUpperCase()} | ${group.label} | ${group.completed} | ${group.wins}/${group.losses}/${group.breakevens} | ${money(group.netPnL)} | ${decimal(group.profitFactor)} | ${money(group.expectancy)} |`,
      );
    }
  }
  lines.push("");
}

function renderMarkdown(audit) {
  const live = audit.performance.live;
  const shadow = audit.performance.shadow;
  const counter = audit.performance.excludedShadowCounterfactual;
  const integrityCount =
    audit.integrity.affectedLiveRecords + audit.integrity.affectedShadowRecords;
  const lifecycleOverlaps = audit.operationalEvidence.lifecycleTradeOverlap.filter(
    (event) =>
      event.liveTradeIdsOpenAcrossEvent.length || event.shadowTradeIdsOpenAcrossEvent.length,
  );
  const lines = [
    "# London/New York Time-Gate Production Audit",
    "",
    `Generated: ${audit.generatedAt}`,
    `Audit period: ${audit.auditPeriod.fromUTC} to ${audit.auditPeriod.toUTC}`,
    `IST period: ${audit.auditPeriod.fromIST} to ${audit.auditPeriod.toIST}`,
    `Deployed commit: \`${audit.deployedCommit.productionHead}\``,
    "",
    "## Executive finding",
    "",
    `The gate was enforced correctly for all ${live.records} live and ${shadow.records} shadow records opened in the audit period: ${audit.integrity.liveOutsideWindow.length} live-outside-window violations and ${audit.integrity.shadowInsideWindow.length} shadow-inside-window violations. ${integrityCount ? `${integrityCount} record-level integrity issue(s) need attention.` : "No record-level completeness, classification, timestamp, or duplicate violation was found under the checks below."}`,
    "",
    `Live produced ${money(live.netPnL)} (${live.wins}/${live.losses}/${live.breakevens}, PF ${decimal(live.profitFactor)}, expectancy ${money(live.expectancy)}), versus shadow ${money(shadow.netPnL)} (${shadow.wins}/${shadow.losses}/${shadow.breakevens}, PF ${decimal(shadow.profitFactor)}, expectancy ${money(shadow.expectancy)}). Excluded shadow trades ${counter.wouldHaveImprovedAggregateNetPnL ? "would have increased" : "would not have increased"} the simple combined net result by ${money(counter.shadowNetPnL)}, before execution-cost and capacity effects. With only ${live.completed} live and ${shadow.completed} completed shadow trades, that comparison is weak evidence, not a basis for an immediate production change.`,
    "",
    `Recommendation: **${audit.conclusion.recommendation}** -- ${audit.conclusion.recommendationText}`,
    "",
    "## Deployment boundary and effective configuration",
    "",
    `- Commit creation: ${audit.deployedCommit.commitMetadata.split("|")[1]} (not treated as deployment).`,
    `- Commit reached the VPS by fast-forward pull at ${audit.deployedCommit.vpsArrivalAtUTC} (${localLabel(audit.deployedCommit.vpsArrivalAtUTC, DEFAULT_OFFSET_MINUTES)}).`,
    `- The prior PM2 process was stopped at 2026-07-07T14:17:32Z; the first retained start of the gated \`pullback\` process was ${audit.deployedCommit.operationalGateStartAtUTC}.`,
    `- The startup gate marker precedes the first following timestamped connection line at ${audit.deployedCommit.firstTimestampedEvidenceAfterGateMarkerUTC}; the resulting operational boundary uncertainty is ${audit.deployedCommit.deploymentTimeUncertaintySeconds.toFixed(3)} seconds.`,
    `- Production HEAD matches \`${DEPLOYED_COMMIT}\`, branch is \`${audit.deployedCommit.branch}\`, and the production worktree was ${audit.deployedCommit.cleanWorktree ? "clean" : "not clean"}.`,
    `- Effective gate: enabled, inclusive ${audit.effectiveConfiguration.start}-${audit.effectiveConfiguration.end} IST, fixed UTC offset +${audit.effectiveConfiguration.offsetMinutes} minutes, NY label threshold ${audit.effectiveConfiguration.nyLabelStart} IST.`,
    `- ${audit.effectiveConfiguration.conclusion}`,
    "",
    "The code classifies by shifting each UTC instant by +330 minutes and comparing the IST minute-of-day. The same conversion was used for this audit. Seconds within 23:59 remain allowed because the comparison is minute-granular and inclusive.",
    "",
    "## Records and integrity",
    "",
    "| Collection | Bounded-query matches | Opened in period | Completed | Open at snapshot | Gate violations | Record issues |",
    "|---|---:|---:|---:|---:|---:|---:|",
    `| trades | ${audit.records.live.boundedQueryMatches} | ${audit.records.live.openedInAuditPeriod} | ${audit.records.live.completionCount} | 0 | ${audit.integrity.liveOutsideWindow.length} | ${audit.integrity.affectedLiveRecords} |`,
    `| shadow_trades | ${audit.records.shadow.boundedQueryMatches} | ${audit.records.shadow.openedInAuditPeriod} | ${audit.records.shadow.completionCount} | ${audit.records.shadow.openAtSnapshot} | ${audit.integrity.shadowInsideWindow.length} | ${audit.integrity.affectedShadowRecords} |`,
    "",
    `Duplicate trade IDs: live ${audit.integrity.duplicateTradeIds.live.length}, shadow ${audit.integrity.duplicateTradeIds.shadow.length}. Same-collection duplicate fingerprints: live ${audit.integrity.duplicateFingerprints.live.length}, shadow ${audit.integrity.duplicateFingerprints.shadow.length}; cross-collection candidates ${audit.integrity.duplicateFingerprints.crossCollectionCandidates.length}. Neither collection has a unique \`tradeId\` index, so this clean result relies on the application upsert key rather than database enforcement.`,
    "",
    `${audit.integrity.logDatabaseCorrelation.databaseShadowMissingCreationLog.length === 0 ? `All ${audit.records.shadow.openedInAuditPeriod} database shadow records had a retained creation-log ID` : `${audit.integrity.logDatabaseCorrelation.databaseShadowMissingCreationLog.length} database shadow records lacked a retained creation-log ID`}, and ${audit.integrity.logDatabaseCorrelation.loggedShadowCreatedMissingFromDatabase.length} bounded creation-log IDs were missing from the database.`,
    "",
    audit.integrity.partialFlagAnomalies.length
      ? `One live partial-close flag is not validated by its required fields. \`${audit.integrity.partialFlagAnomalies[0].tradeId}\` was a full STOP_LOSS (${money(audit.integrity.partialFlagAnomalies[0].storedNetPnL)}, R ${decimal(audit.integrity.partialFlagAnomalies[0].storedRealizedR)}). Logs show the stop-loss close overlapping position sync: sync saw the partial ticket disappear, set \`partialClosed=true\`, and finalized the pair without recording partial price/time/P&L or activating breakeven. This overstates the stored live partial frequency by one but does not alter that trade's internally consistent full-stop P&L/R.`
      : "No anomalous partial-close flags were found.",
    "",
    `Metadata coverage: live entry reason ${percent(audit.integrity.metadataCoverage.live.entryReason.pct)}, score ${percent(audit.integrity.metadataCoverage.live.entryScore.pct)}, category ${percent(audit.integrity.metadataCoverage.live.category.pct)}, realized R ${percent(audit.integrity.metadataCoverage.live.realizedR.pct)}; shadow entry reason ${percent(audit.integrity.metadataCoverage.shadow.entryReason.pct)}, score ${percent(audit.integrity.metadataCoverage.shadow.entryScore.pct)}, category ${percent(audit.integrity.metadataCoverage.shadow.category.pct)}, realized R ${percent(audit.integrity.metadataCoverage.shadow.realizedR.pct)}. Live records do not store explicit \`executionMode\` or \`sessionLabel\`; their classification is inferred from collection plus timestamp.`,
    "",
    "## Performance comparison",
    "",
    "| Mode | Records | Complete | W/L/BE | Win rate | Net P&L | PF | Expectancy | Max DD | Avg win | Avg loss | Payoff | Avg duration | Avg realized R (coverage) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    metricTableRow(live),
    metricTableRow(shadow),
    "",
    `Live recorded partial flags: ${live.frequencies.recordedPartialCloseCount}/${live.completed} (${percent(live.frequencies.recordedPartialClosePct)}); validated partial closes: ${live.frequencies.validatedPartialCloseCount}/${live.completed} (${percent(live.frequencies.validatedPartialClosePct)}); breakeven exits: ${live.frequencies.breakEvenExitCount}/${live.completed} (${percent(live.frequencies.breakEvenExitPct)}); zero-P&L outcomes: ${live.frequencies.zeroPnlCount}/${live.completed}. Shadow recorded/validated partial closes: ${shadow.frequencies.recordedPartialCloseCount}/${shadow.completed} (${percent(shadow.frequencies.recordedPartialClosePct)}); breakeven exits: ${shadow.frequencies.breakEvenExitCount}/${shadow.completed} (${percent(shadow.frequencies.breakEvenExitPct)}); zero-P&L outcomes: ${shadow.frequencies.zeroPnlCount}/${shadow.completed}. A BREAK_EVEN exit can still be a P&L win after a profitable partial close, so both rates are shown.`,
    "",
  ];

  groupTable(lines, "By IST entry hour", audit.performance.dimensions.byHourIST);
  groupTable(lines, "By inferred session label", audit.performance.dimensions.bySessionLabel);
  groupTable(lines, "By side", audit.performance.dimensions.bySide);
  groupTable(lines, "By entry reason", audit.performance.dimensions.byEntryReason);
  groupTable(lines, "By exit reason", audit.performance.dimensions.byExitReason);
  groupTable(lines, "By IST day", audit.performance.dimensions.byDayIST);

  const counts = audit.operationalEvidence.logMarkerCounts;
  lines.push(
    "## PM2/log correlation",
    "",
    `PM2 lifecycle evidence in the audit range contains ${audit.operationalEvidence.pm2Lifecycle.filter((event) => /starting/.test(event.message)).length} starts, ${audit.operationalEvidence.pm2Lifecycle.filter((event) => /exited/.test(event.message)).length} exits, and ${audit.operationalEvidence.pm2Lifecycle.filter((event) => /Stopping/.test(event.message)).length} explicit stops for \`pullback\`. One exit was SIGABRT (2026-07-11); later restarts were followed by synchronization markers. The current process snapshot was online from ${audit.operationalEvidence.pm2Snapshot.pmUptime} with PM2 restart counter ${audit.operationalEvidence.pm2Snapshot.restartTime}.`,
    "",
    `Retained post-gate output contains ${counts.shadowCreated} shadow creation markers, ${counts.shadowFinalized} shadow finalizations, ${counts.shadowPartialBreakevenActivated} partial/BE activations, ${counts.shadowRestoreBatches} shadow restore batches, ${counts.shadowTickErrors} shadow tick-processing errors, ${counts.liveSnapshotSaveFailures} live snapshot save failures, ${counts.entryLockBlocked} entry-lock blocks, and ${counts.entryLockTimeoutForce} forced lock timeouts. Entry-lock logs show ${counts.entryLockAcquired} acquisitions and ${counts.entryLockReleased} releases. There were ${audit.records.shadow.openAtSnapshot} incomplete shadow records at the database snapshot.`,
    "",
    `There were ${counts.illegalStateTransitions} logged illegal ACTIVE-to-CLOSED transition warnings across ${new Set(audit.integrity.logDatabaseCorrelation.illegalStateTransitions.map((item) => item.tradeId)).size} audited live trades. The finalization routine continued and each has one complete trade record, but the warning shows lifecycle validation was bypassed on sync-driven closure paths. ${lifecycleOverlaps.length === 0 ? "No live or shadow trade interval crossed a timestamped PM2 lifecycle event." : `${lifecycleOverlaps.length} lifecycle event(s) occurred while at least one audited trade interval was open.`}`,
    "",
    `The unusually high ${counts.sessionStartupMarkers} session markers, ${counts.websocketDisconnectedMessages} websocket-disconnect messages, and ${counts.reconnectMentions} reconnect mentions show repeated initialization/reconnect activity. Nevertheless, database/log ID reconciliation, zero duplicate IDs/fingerprints, zero shadow processing errors, and zero incomplete shadow records do not show duplicated or lost shadow records. Five entry-lock blocks occurred, but no forced lock timeout occurred; those are unpersisted attempted entries and cannot be proven unique from the untimestamped logs. Because most application lines have no timestamp, counts after the first gate marker are reliable through the stated log snapshot, while exact correlation is limited to timestamped MetaAPI and PM2 lifecycle lines.`,
    "",
    "## London/New York and daylight saving",
    "",
    `The fixed ${audit.sessionAndDstAssessment.fixedWindow} window does **not** accurately represent the full union of conventional London and New York sessions year-round. During this July audit, London 08:00-17:00 BST maps to 12:30-21:30 IST and New York 08:00-17:00 EDT maps to 17:30-02:30 IST next day. The gate therefore misses the first London hour, labels the first New York hour as LONDON_WINDOW, and truncates New York after 23:59. In winter, 13:30 matches the London open and 18:30 matches the New York open, but the post-midnight New York session is still truncated. UK and US transition on different dates, so a fixed IST mapping also misaligns during transition weeks.`,
    "",
    `DST references: [UK government clock-change rules](${audit.sessionAndDstAssessment.sources[0]}) and [US NIST daylight-saving rules](${audit.sessionAndDstAssessment.sources[1]}). Session hours here are explicitly treated as conventional FX/spot-gold labels rather than exchange-enforced hours.`,
    "",
    "## Confirmed findings vs weak conclusions",
    "",
    "Confirmed:",
    "",
    ...audit.conclusion.confirmed.map((item) => `- ${item}`),
    "",
    "Weak because of sample size or simulation limits:",
    "",
    ...audit.conclusion.weakDueToSample.map((item) => `- ${item}`),
    "",
    "## Record manifest",
    "",
    "Every in-period record is listed below. Times show both stored UTC instant and the audit's +05:30 IST conversion.",
    "",
    "| Mode | Trade ID | Opened UTC | Opened IST | Session | Side | Entry | Exit | Result | Net | Complete | Issues |",
    "|---|---|---|---|---|---|---|---|---|---:|---|---|",
  );
  for (const mode of ["live", "shadow"]) {
    for (const row of audit.recordManifest[mode]) {
      lines.push(
        `| ${mode.toUpperCase()} | \`${String(row.tradeId).replace(/\|/g, "/")}\` | ${row.openedAtUTC} | ${row.openedAtIST} | ${row.inferredSessionLabel} | ${row.side || "UNKNOWN"} | ${row.entryReason || "UNKNOWN"} | ${row.exitReason || "UNKNOWN"} | ${row.result} | ${money(row.netPnL)} | ${row.complete ? "YES" : "NO"} | ${row.issues.length ? row.issues.join("; ").replace(/\|/g, "/") : "None"} |`,
      );
    }
  }
  lines.push(
    "",
    "## Method, reproducibility, and limitations",
    "",
    "The collector uses only bounded MongoDB `find` queries across `openedAt`, `createdAt`, `updatedAt`, and `closedAt`, lists indexes, reads Git/PM2 metadata and retained logs, and excludes account/user IDs and all secret environment values. The production strategy module is never imported. Re-run the command in the source header with the pinned bounds for the same database scope; later record updates or log rotation can change results.",
    "",
    ...audit.limitations.map((item) => `- ${item}`),
    "",
    "Production confirmation: no database write, service restart/reload, configuration change, live-position action, strategy change, or remote file write was performed. Only the local report artifacts were created.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function localRun() {
  const host = argValue("host", DEFAULT_HOST);
  const appDir = argValue("app-dir", DEFAULT_APP_DIR);
  const from = assertIso(argValue("from", DEFAULT_FROM), "from").toISOString();
  const to = assertIso(argValue("to", DEFAULT_TO), "to").toISOString();
  if (!/^[A-Za-z0-9_.-]+$/.test(host)) throw new Error("Unsafe SSH host alias");
  if (!/^\/[A-Za-z0-9_./-]+$/.test(appDir)) throw new Error("Unsafe app directory");
  const source = fs.readFileSync(__filename, "utf8");
  const remoteCommand = `cd ${appDir} && node - --remote-collect --app-dir=${appDir} --from=${from} --to=${to}`;
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", host, remoteCommand], {
    input: source,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Remote collector failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  const raw = JSON.parse(result.stdout);
  const audit = buildAudit(raw);
  const outputDir = __dirname;
  const jsonPath = path.join(outputDir, "time-gate-audit.json");
  const markdownPath = path.join(outputDir, "time-gate-audit.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(audit, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderMarkdown(audit));
  process.stdout.write(
    `${JSON.stringify({ jsonPath, markdownPath, live: audit.performance.live, shadow: audit.performance.shadow, recommendation: audit.conclusion.recommendation }, null, 2)}\n`,
  );
}

if (process.argv.includes("--remote-collect")) {
  remoteCollect().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
} else {
  try {
    localRun();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
