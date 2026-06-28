const DEFAULT_START = "13:30";
const DEFAULT_END = "23:59";
const DEFAULT_OFFSET_MINUTES = 330;

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseClockToMinutes(value, fallback) {
  const text = String(value || fallback || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) return parseClockToMinutes(fallback, DEFAULT_START);

  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2])));
  return hour * 60 + minute;
}

function formatMinutes(minutes) {
  const normalized = Math.max(0, Math.min(1439, Number(minutes) || 0));
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function tradingOffsetMinutes() {
  return toNumber(
    process.env.TRADING_SESSION_TZ_OFFSET_MINUTES,
    toNumber(process.env.REPORT_TZ_OFFSET_MINUTES, DEFAULT_OFFSET_MINUTES),
  );
}

function liveSessionStartMinutes() {
  return parseClockToMinutes(
    process.env.LIVE_SESSION_START_IST || process.env.LIVE_SESSION_START,
    DEFAULT_START,
  );
}

function liveSessionEndMinutes() {
  return parseClockToMinutes(
    process.env.LIVE_SESSION_END_IST || process.env.LIVE_SESSION_END,
    DEFAULT_END,
  );
}

function liveSessionGateEnabled() {
  return process.env.LIVE_SESSION_GATE_ENABLED !== "false";
}

function localMinutesForDate(value, offsetMinutes = tradingOffsetMinutes()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function isMinuteWithinWindow(minute, start, end) {
  if (!Number.isFinite(minute)) return false;
  if (start <= end) return minute >= start && minute <= end;
  return minute >= start || minute <= end;
}

function sessionWindowLabel() {
  return `${formatMinutes(liveSessionStartMinutes())}-${formatMinutes(
    liveSessionEndMinutes(),
  )} IST`;
}

function sessionLabelForDate(value) {
  const minute = localMinutesForDate(value);
  if (!Number.isFinite(minute)) return "UNKNOWN";

  const start = liveSessionStartMinutes();
  const end = liveSessionEndMinutes();
  const nyStart = parseClockToMinutes(process.env.NY_SESSION_START_IST, "18:30");

  if (isMinuteWithinWindow(minute, start, end)) {
    return minute >= nyStart || nyStart < start ? "NY_WINDOW" : "LONDON_WINDOW";
  }

  if (start <= end) {
    return minute < start ? "PRE_LONDON_WINDOW" : "AFTER_SESSION_CUTOFF";
  }

  return "OUTSIDE_LIVE_WINDOW";
}

function getLiveSessionDecision(value = new Date()) {
  const enabled = liveSessionGateEnabled();
  const start = liveSessionStartMinutes();
  const end = liveSessionEndMinutes();
  const minute = localMinutesForDate(value);
  const withinWindow = isMinuteWithinWindow(minute, start, end);

  return {
    enabled,
    allowed: !enabled || withinWindow,
    withinWindow,
    minute,
    start,
    end,
    label: sessionWindowLabel(),
    sessionLabel: sessionLabelForDate(value),
  };
}

module.exports = {
  formatMinutes,
  getLiveSessionDecision,
  isMinuteWithinWindow,
  liveSessionEndMinutes,
  liveSessionGateEnabled,
  liveSessionStartMinutes,
  localMinutesForDate,
  sessionLabelForDate,
  sessionWindowLabel,
  tradingOffsetMinutes,
};
