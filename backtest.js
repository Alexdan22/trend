process.env.ENGINE_MODE = "BACKTEST";

const fs = require("fs");
const path = require("path");

const {
  strategyEngine,
  resetStrategyEngine,
} = require("./src/strategy/strategyEngine");

const {
  initSymbol,
  getContext,
  updatePrice,
} = require("./src/core/symbolRegistry");

// =========================
// CLI / CONFIG
// =========================

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));

  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];

  return fallback;
}

function numericArg(name, fallback) {
  const value = Number(getArg(name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

const SYMBOL = getArg("symbol", "XAUUSD");
const DATA_FILE = path.resolve(
  __dirname,
  getArg("data", path.join("data", "XAUUSD_M5.json")),
);
const INITIAL_BALANCE = numericArg("initial-balance", 10000);
const CONTRACT_SIZE = numericArg("contract-size", 100);
const TOTAL_LOT = numericArg("lot", 0.02);
const FILL_MODE = getArg("fill-mode", "ohlc");
const SPREAD = numericArg("spread", 0);
const SLIPPAGE = numericArg("slippage", 0);
const ENTRY_MODE = getArg("entry-mode", "all").toLowerCase();
const MIN_SCORE_RAW = getArg("min-score", null);
const PARSED_MIN_SCORE =
  MIN_SCORE_RAW == null || MIN_SCORE_RAW === ""
    ? null
    : Number(MIN_SCORE_RAW);
const MIN_SCORE = Number.isFinite(PARSED_MIN_SCORE) ? PARSED_MIN_SCORE : null;
const REPORT_PREFIX = getArg("report-prefix", "backtest").replace(
  /[^a-zA-Z0-9._-]/g,
  "_",
);
const OUTPUT_DIR = path.resolve(
  __dirname,
  getArg("output-dir", path.join("artifacts", "backtests")),
);

const MAX_CANDLES = 500;
const MIN_LOT = 0.01;
const ATR_PERIOD = 14;
const ATR_TRIGGER_MULTIPLIER = 1.5;
const FALLBACK_SL_DISTANCE = 4;
const FALLBACK_TP_DISTANCE = 8;
const MAX_TP_DISTANCE = 30;
const MAX_SL_DISTANCE = 8;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const LOG_FILE = path.join(OUTPUT_DIR, `${REPORT_PREFIX}-logs.txt`);
const REPORT_MD_FILE = path.join(OUTPUT_DIR, `${REPORT_PREFIX}-report.md`);
const REPORT_JSON_FILE = path.join(OUTPUT_DIR, `${REPORT_PREFIX}-report.json`);

// =========================
// INDICATOR HELPERS
// =========================

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

function calculateRSI(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calculateSMA(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateStdDev(values, period) {
  if (values.length < period) return null;

  const slice = values.slice(-period);
  const mean = calculateSMA(values, period);
  const variance =
    slice.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / period;

  return Math.sqrt(variance);
}

function calculateBollingerBands(values, period = 20, mult = 2) {
  const mid = calculateSMA(values, period);
  const std = calculateStdDev(values, period);

  if (mid == null || std == null) return null;

  return {
    upper: mid + mult * std,
    lower: mid - mult * std,
    middle: mid,
    width: mid === 0 ? 0 : (2 * mult * std) / mid,
  };
}

function calculateStochastic(candles, period = 14) {
  if (candles.length < period) return null;

  const slice = candles.slice(-period);
  const highs = slice.map((candle) => candle.high);
  const lows = slice.map((candle) => candle.low);
  const highestHigh = Math.max(...highs);
  const lowestLow = Math.min(...lows);
  const lastClose = slice[slice.length - 1].close;

  if (highestHigh === lowestLow) return null;

  return ((lastClose - lowestLow) / (highestHigh - lowestLow)) * 100;
}

function computeATR(candles, period = ATR_PERIOD) {
  if (candles.length < period + 1) return null;

  const start = candles.length - period;
  const trs = [];

  for (let i = start; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    if (!curr || !prev) continue;

    const highLow = curr.high - curr.low;
    const highClose = Math.abs(curr.high - prev.close);
    const lowClose = Math.abs(curr.low - prev.close);

    trs.push(Math.max(highLow, highClose, lowClose));
  }

  if (!trs.length) return null;

  return trs.reduce((sum, value) => sum + value, 0) / trs.length;
}

// =========================
// DATA / CONTEXT
// =========================

function parseDateTime(raw) {
  if (raw.Date && raw.Time) {
    const [year, month, day] = String(raw.Date).split(".").map(Number);
    const timeParts = String(raw.Time).split(":").map(Number);
    const hour = timeParts[0] || 0;
    const minute = timeParts[1] || 0;
    const second = timeParts[2] || 0;

    return Date.UTC(year, month - 1, day, hour, minute, second);
  }

  const rawTime = raw.time ?? raw.timestamp ?? raw.Time ?? raw.Date;
  const timestamp =
    typeof rawTime === "number" ? rawTime : new Date(rawTime).getTime();

  if (!Number.isFinite(timestamp)) {
    throw new Error(`Unable to parse candle timestamp: ${JSON.stringify(raw)}`);
  }

  return timestamp;
}

function normalizeCandle(raw) {
  const candle = {
    time: parseDateTime(raw),
    open: Number(raw.Open ?? raw.open),
    high: Number(raw.High ?? raw.high),
    low: Number(raw.Low ?? raw.low),
    close: Number(raw.Close ?? raw.close),
    volume: Number(raw.Volume ?? raw.volume ?? 0),
  };

  for (const key of ["time", "open", "high", "low", "close"]) {
    if (!Number.isFinite(candle[key])) {
      throw new Error(`Invalid ${key} in candle: ${JSON.stringify(raw)}`);
    }
  }

  return candle;
}

function loadCandles(filePath) {
  const raw = require(filePath);

  if (!Array.isArray(raw)) {
    throw new Error("Historical data must be an array");
  }

  return raw.map(normalizeCandle).sort((a, b) => a.time - b.time);
}

function pushCapped(array, value, limit = MAX_CANDLES) {
  array.push(value);
  if (array.length > limit) array.shift();
}

initSymbol(SYMBOL);
const ctx = getContext(SYMBOL);
ctx.candles.m1 = [];
ctx.candles.m5 = [];
ctx.candles.m15 = [];
resetStrategyEngine();

function replayCandleIntoContext(candle) {
  const { time, open, high, low, close, volume = 0 } = candle;

  updatePrice(SYMBOL, close, close, time);

  ctx.timestamp = time;
  ctx.price = {
    bid: close,
    ask: close,
    spread: 0,
    timestamp: time,
  };

  pushCapped(ctx.candles.m5, {
    time,
    open,
    high,
    low,
    close,
    volume,
  });

  const bucket15 = Math.floor(time / 900000) * 900000;
  let last15 = ctx.candles.m15[ctx.candles.m15.length - 1];

  if (!last15 || last15.time !== bucket15) {
    pushCapped(ctx.candles.m15, {
      time: bucket15,
      open,
      high,
      low,
      close,
      volume,
    });
  } else {
    last15.high = Math.max(last15.high, high);
    last15.low = Math.min(last15.low, low);
    last15.close = close;
    last15.volume = (last15.volume || 0) + volume;
  }

  const m5Closes = ctx.candles.m5.map((item) => item.close);
  const m15Closes = ctx.candles.m15.map((item) => item.close);

  ctx.indicators.rsi = calculateRSI(m5Closes, 14);
  ctx.indicators.stochastic = calculateStochastic(ctx.candles.m5, 14);
  ctx.indicators.ema50 = calculateEMA(m15Closes, 50);
  ctx.indicators.ema200 = calculateEMA(m15Closes, 200);
  ctx.indicators.bollinger = calculateBollingerBands(m5Closes, 20, 2);
  ctx.indicators.atr = computeATR(ctx.candles.m5, 14);

  if (
    ctx.indicators.prevStochastic != null &&
    ctx.indicators.stochastic != null
  ) {
    ctx.indicators.stochasticDelta =
      ctx.indicators.stochastic - ctx.indicators.prevStochastic;
  }

  ctx.indicators.prevStochastic = ctx.indicators.stochastic;
}

// =========================
// EXNESS-STYLE TRADE MODEL
// =========================

function calculateDynamicSLTP(side, entryPrice) {
  const atr = computeATR(ctx.candles.m5, ATR_PERIOD);
  if (!atr || atr <= 0) return null;

  const recent = ctx.candles.m5.slice(-3);
  if (recent.length < 3) return null;

  const high = Math.max(...recent.map((candle) => candle.high));
  const low = Math.min(...recent.map((candle) => candle.low));
  const retracement = Math.abs(high - low);

  const rawSlDistance = Math.max(
    retracement * 0.5,
    atr * ATR_TRIGGER_MULTIPLIER,
  );
  const slDistance = Math.min(rawSlDistance, MAX_SL_DISTANCE);
  const tpDistance = Math.min(slDistance * 2, MAX_TP_DISTANCE);

  if (side === "BUY") {
    return {
      sl: entryPrice - slDistance,
      tp: entryPrice + tpDistance,
      slDistance,
    };
  }

  return {
    sl: entryPrice + slDistance,
    tp: entryPrice - tpDistance,
    slDistance,
  };
}

function direction(side) {
  return side === "BUY" ? 1 : -1;
}

function halfSpread() {
  return SPREAD / 2;
}

function quotedEntryPrice(side, midPrice) {
  return midPrice + direction(side) * halfSpread();
}

function entryFillPrice(side, midPrice) {
  return quotedEntryPrice(side, midPrice) + direction(side) * SLIPPAGE;
}

function exitComparablePrice(side, midPrice) {
  return midPrice - direction(side) * halfSpread();
}

function exitFillAtLevel(side, level) {
  return level - direction(side) * SLIPPAGE;
}

function exitFillFromMid(side, midPrice) {
  return exitComparablePrice(side, midPrice) - direction(side) * SLIPPAGE;
}

function isHit(side, price, level, kind) {
  if (side === "BUY") {
    return kind === "above" ? price >= level : price <= level;
  }

  return kind === "above" ? price <= level : price >= level;
}

function buildSyntheticPath(candle) {
  if (FILL_MODE === "close") {
    return [{ label: "close", price: candle.close }];
  }

  const path =
    candle.close >= candle.open
      ? [
          ["open", candle.open],
          ["low", candle.low],
          ["high", candle.high],
          ["close", candle.close],
        ]
      : [
          ["open", candle.open],
          ["high", candle.high],
          ["low", candle.low],
          ["close", candle.close],
        ];

  return path.reduce((items, [label, price]) => {
    const prev = items[items.length - 1];
    if (!prev || prev.price !== price) items.push({ label, price });
    return items;
  }, []);
}

const openTrades = [];
const closedTrades = [];
const equityEvents = [
  {
    time: null,
    event: "START",
    pnl: 0,
    equity: INITIAL_BALANCE,
  },
];

const counters = {
  entrySignals: 0,
  entries: 0,
  skippedEntries: 0,
  filteredEntries: 0,
  filteredByMode: 0,
  filteredByScore: 0,
  fallbackSltp: 0,
  forcedExits: 0,
};

let equity = INITIAL_BALANCE;
let equityPeak = INITIAL_BALANCE;
let maxDrawdown = 0;
let nextTradeId = 1;

function pnlFor(trade, exitPrice, lot) {
  return (
    (exitPrice - trade.entryPrice) *
    direction(trade.side) *
    lot *
    CONTRACT_SIZE
  );
}

function recordRealized(trade, event, time, price, lot, label) {
  const pnl = pnlFor(trade, price, lot);
  equity += pnl;

  if (equity > equityPeak) equityPeak = equity;

  const drawdown = equityPeak - equity;
  if (drawdown > maxDrawdown) maxDrawdown = drawdown;

  const payload = {
    time,
    tradeId: trade.id,
    side: trade.side,
    event,
    label,
    price,
    lot,
    pnl,
    equity,
  };

  trade.realizedPnL += pnl;
  trade.events.push(payload);
  equityEvents.push(payload);

  fs.appendFileSync(
    LOG_FILE,
    `[${new Date(time).toISOString()}] ${trade.id} ${trade.side} ${event} ${label} price=${price.toFixed(
      3,
    )} lot=${lot.toFixed(2)} pnl=${pnl.toFixed(2)} equity=${equity.toFixed(
      2,
    )}\n`,
  );
}

function closeLeg(trade, leg, price, time, reason, label) {
  if (leg === "PARTIAL") {
    if (!trade.partialLegOpen) return;

    trade.partialLegOpen = false;
    trade.partialClosed = true;
    trade.partialExitPrice = price;
    recordRealized(trade, reason, time, price, trade.lotEach, label);
    return;
  }

  if (!trade.trailingLegOpen) return;

  trade.trailingLegOpen = false;
  trade.trailingExitPrice = price;
  recordRealized(trade, reason, time, price, trade.lotEach, label);
}

function finalizeTrade(trade, time, exitPrice, reason, label) {
  if (trade.status === "CLOSED") return;

  trade.status = "CLOSED";
  trade.exitTime = time;
  trade.exitPrice = exitPrice;
  trade.exitReason = reason;
  trade.exitLabel = label;
  trade.durationMinutes = (time - trade.entryTime) / 60000;
  trade.realizedR =
    trade.plannedRisk > 0 ? trade.realizedPnL / trade.plannedRisk : 0;

  const index = openTrades.indexOf(trade);
  if (index >= 0) openTrades.splice(index, 1);

  closedTrades.push(trade);
}

function processTradeAtPrice(trade, time, price, label) {
  if (trade.status === "CLOSED") return;

  const side = trade.side;
  const partialTarget = trade.partialTarget;

  if (
    trade.partialLegOpen &&
    !trade.partialClosed &&
    isHit(side, price, partialTarget, "above")
  ) {
    closeLeg(
      trade,
      "PARTIAL",
      exitFillAtLevel(side, partialTarget),
      time,
      "PARTIAL",
      label,
    );
    trade.breakEvenActive = true;
    trade.internalSL = trade.entryPrice;
  }

  if (isHit(side, price, trade.tp, "above")) {
    if (trade.partialLegOpen) {
      closeLeg(
        trade,
        "PARTIAL",
        exitFillAtLevel(side, trade.tp),
        time,
        "TP_HIT",
        label,
      );
    }

    if (trade.trailingLegOpen) {
      closeLeg(
        trade,
        "TRAILING",
        exitFillAtLevel(side, trade.tp),
        time,
        "TP_HIT",
        label,
      );
    }

    finalizeTrade(trade, time, exitFillAtLevel(side, trade.tp), "TP_HIT", label);
    return;
  }

  if (
    trade.breakEvenActive &&
    trade.trailingLegOpen &&
    isHit(side, price, trade.entryPrice, "below")
  ) {
    closeLeg(
      trade,
      "TRAILING",
      exitFillAtLevel(side, trade.entryPrice),
      time,
      "BREAK_EVEN",
      label,
    );
    finalizeTrade(
      trade,
      time,
      exitFillAtLevel(side, trade.entryPrice),
      "BREAK_EVEN",
      label,
    );
    return;
  }

  if (
    !trade.breakEvenActive &&
    (trade.partialLegOpen || trade.trailingLegOpen) &&
    isHit(side, price, trade.sl, "below")
  ) {
    closeLeg(
      trade,
      "PARTIAL",
      exitFillAtLevel(side, trade.sl),
      time,
      "STOP_LOSS",
      label,
    );
    closeLeg(
      trade,
      "TRAILING",
      exitFillAtLevel(side, trade.sl),
      time,
      "STOP_LOSS",
      label,
    );
    finalizeTrade(
      trade,
      time,
      exitFillAtLevel(side, trade.sl),
      "STOP_LOSS",
      label,
    );
  }
}

function processOpenTradesForCandle(candle) {
  const pathItems = buildSyntheticPath(candle);

  for (const trade of [...openTrades]) {
    if (candle.time <= trade.entryTime) continue;

    trade.barsHeld += 1;

    for (const point of pathItems) {
      processTradeAtPrice(
        trade,
        candle.time,
        exitComparablePrice(trade.side, point.price),
        point.label,
      );
      if (trade.status === "CLOSED") break;
    }
  }
}

function shouldTakeEntry(result) {
  const entry = result.entry || {};
  const score = Number(result.score);
  let allowed = true;

  if (ENTRY_MODE === "behavioral" && !entry.behavioralQualified) {
    counters.filteredByMode += 1;
    allowed = false;
  }

  if (ENTRY_MODE === "score" && !entry.scoreQualified) {
    counters.filteredByMode += 1;
    allowed = false;
  }

  if (MIN_SCORE != null && (!Number.isFinite(score) || score < MIN_SCORE)) {
    counters.filteredByScore += 1;
    allowed = false;
  }

  if (!allowed) {
    counters.filteredEntries += 1;
  }

  return allowed;
}

function createTrade(side, score, candle, entry = {}) {
  const lotEach = Number((TOTAL_LOT / 2).toFixed(2));

  if (lotEach < MIN_LOT) {
    counters.skippedEntries += 1;
    return null;
  }

  const entryRef = quotedEntryPrice(side, candle.close);
  const entryPrice = entryFillPrice(side, candle.close);
  let sltp = calculateDynamicSLTP(side, entryRef);
  let usedFallback = false;

  if (!sltp) {
    usedFallback = true;
    counters.fallbackSltp += 1;

    if (side === "BUY") {
      sltp = {
        sl: entryRef - FALLBACK_SL_DISTANCE,
        tp: entryRef + FALLBACK_TP_DISTANCE,
        slDistance: FALLBACK_SL_DISTANCE,
      };
    } else {
      sltp = {
        sl: entryRef + FALLBACK_SL_DISTANCE,
        tp: entryRef - FALLBACK_TP_DISTANCE,
        slDistance: FALLBACK_SL_DISTANCE,
      };
    }
  }

  const tpDistance = Math.abs(sltp.tp - entryPrice);
  const plannedRisk = Math.abs(entryPrice - sltp.sl) * lotEach * 2 * CONTRACT_SIZE;
  const plannedRR =
    Math.abs(entryPrice - sltp.sl) > 0
      ? tpDistance / Math.abs(entryPrice - sltp.sl)
      : 0;

  const trade = {
    id: `BT-${String(nextTradeId).padStart(4, "0")}`,
    side,
    score,
    entryMode: ENTRY_MODE,
    entryReason: entry.reason || "UNKNOWN",
    behavioralQualified: Boolean(entry.behavioralQualified),
    scoreQualified: Boolean(entry.scoreQualified),
    entryScores: entry.scores || null,
    behavioral: entry.behavioral || null,
    symbol: SYMBOL,
    entryTime: candle.time,
    entryRef,
    entryPrice,
    sl: sltp.sl,
    tp: sltp.tp,
    slDistance: sltp.slDistance,
    tpDistance,
    plannedRR,
    plannedRisk,
    partialTarget:
      side === "BUY" ? entryPrice + tpDistance * 0.5 : entryPrice - tpDistance * 0.5,
    lotEach,
    totalLot: lotEach * 2,
    usedFallback,
    partialClosed: false,
    breakEvenActive: false,
    internalSL: null,
    partialLegOpen: true,
    trailingLegOpen: true,
    partialExitPrice: null,
    trailingExitPrice: null,
    status: "OPEN",
    exitReason: null,
    exitTime: null,
    exitPrice: null,
    barsHeld: 0,
    durationMinutes: 0,
    realizedPnL: 0,
    realizedR: 0,
    events: [],
  };

  nextTradeId += 1;
  counters.entries += 1;
  openTrades.push(trade);

  fs.appendFileSync(
    LOG_FILE,
    `[${new Date(candle.time).toISOString()}] ${trade.id} ENTRY ${side} entry=${entryPrice.toFixed(
      3,
    )} sl=${trade.sl.toFixed(3)} tp=${trade.tp.toFixed(3)} score=${Number(
      score || 0,
    ).toFixed(2)} reason=${trade.entryReason}\n`,
  );

  return trade;
}

function forceCloseOpenTrades(lastCandle) {
  for (const trade of [...openTrades]) {
    counters.forcedExits += 1;

    if (trade.partialLegOpen) {
      closeLeg(
        trade,
        "PARTIAL",
        exitFillFromMid(trade.side, lastCandle.close),
        lastCandle.time,
        "END_OF_DATA",
        "close",
      );
    }

    if (trade.trailingLegOpen) {
      closeLeg(
        trade,
        "TRAILING",
        exitFillFromMid(trade.side, lastCandle.close),
        lastCandle.time,
        "END_OF_DATA",
        "close",
      );
    }

    finalizeTrade(
      trade,
      lastCandle.time,
      exitFillFromMid(trade.side, lastCandle.close),
      "END_OF_DATA",
      "close",
    );
  }
}

// =========================
// REPORTING
// =========================

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function avg(values) {
  return values.length ? sum(values) / values.length : 0;
}

function max(values) {
  return values.length ? Math.max(...values) : 0;
}

function min(values) {
  return values.length ? Math.min(...values) : 0;
}

function money(value) {
  return `$${value.toFixed(2)}`;
}

function num(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "N/A";
}

function pct(value) {
  return `${num(value, 2)}%`;
}

function iso(time) {
  return time == null ? "N/A" : new Date(time).toISOString();
}

function createSummary(candles) {
  const trades = closedTrades;
  const pnls = trades.map((trade) => trade.realizedPnL);
  const wins = trades.filter((trade) => trade.realizedPnL > 0);
  const losses = trades.filter((trade) => trade.realizedPnL < 0);
  const breakeven = trades.filter((trade) => trade.realizedPnL === 0);
  const grossProfit = sum(wins.map((trade) => trade.realizedPnL));
  const grossLoss = Math.abs(sum(losses.map((trade) => trade.realizedPnL)));
  const netProfit = sum(pnls);
  const maxDrawdownPct =
    equityPeak > 0 ? (maxDrawdown / equityPeak) * 100 : 0;
  const plannedRRs = trades.map((trade) => trade.plannedRR);
  const realizedRs = trades.map((trade) => trade.realizedR);
  const exitReasons = trades.reduce((counts, trade) => {
    counts[trade.exitReason] = (counts[trade.exitReason] || 0) + 1;
    return counts;
  }, {});
  const entryReasons = trades.reduce((counts, trade) => {
    counts[trade.entryReason] = (counts[trade.entryReason] || 0) + 1;
    return counts;
  }, {});

  return {
    symbol: SYMBOL,
    dataFile: DATA_FILE,
    candlesLoaded: candles.length,
    from: iso(candles[0]?.time),
    to: iso(candles[candles.length - 1]?.time),
    settings: {
      initialBalance: INITIAL_BALANCE,
      endingBalance: equity,
      contractSize: CONTRACT_SIZE,
      totalLot: TOTAL_LOT,
      lotEach: Number((TOTAL_LOT / 2).toFixed(2)),
      spread: SPREAD,
      slippage: SLIPPAGE,
      entryMode: ENTRY_MODE,
      minScore: MIN_SCORE,
      fillMode: FILL_MODE,
      maxCandles: MAX_CANDLES,
      atrPeriod: ATR_PERIOD,
      atrTriggerMultiplier: ATR_TRIGGER_MULTIPLIER,
      maxSlDistance: MAX_SL_DISTANCE,
      maxTpDistance: MAX_TP_DISTANCE,
    },
    trades: {
      signals: counters.entrySignals,
      total: trades.length,
      buy: trades.filter((trade) => trade.side === "BUY").length,
      sell: trades.filter((trade) => trade.side === "SELL").length,
      wins: wins.length,
      losses: losses.length,
      breakeven: breakeven.length,
      forcedExits: counters.forcedExits,
      skippedEntries: counters.skippedEntries,
      filteredEntries: counters.filteredEntries,
      filteredByMode: counters.filteredByMode,
      filteredByScore: counters.filteredByScore,
      fallbackSltp: counters.fallbackSltp,
      entryReasons,
      exitReasons,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    },
    pnl: {
      netProfit,
      grossProfit,
      grossLoss,
      profitFactor:
        grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      expectancy: trades.length ? netProfit / trades.length : 0,
      averageWin: avg(wins.map((trade) => trade.realizedPnL)),
      averageLoss: avg(losses.map((trade) => trade.realizedPnL)),
      bestTrade: max(pnls),
      worstTrade: min(pnls),
    },
    risk: {
      averagePlannedRR: avg(plannedRRs),
      averageRealizedR: avg(realizedRs),
      totalRealizedR: sum(realizedRs),
      maxDrawdown,
      maxDrawdownPct,
    },
    duration: {
      averageMinutes: avg(trades.map((trade) => trade.durationMinutes)),
      averageBars: avg(trades.map((trade) => trade.barsHeld)),
    },
  };
}

function serializeTrade(trade) {
  return {
    id: trade.id,
    side: trade.side,
    score: trade.score,
    entryMode: trade.entryMode,
    entryReason: trade.entryReason,
    behavioralQualified: trade.behavioralQualified,
    scoreQualified: trade.scoreQualified,
    entryScores: trade.entryScores,
    behavioral: trade.behavioral,
    entryTime: iso(trade.entryTime),
    exitTime: iso(trade.exitTime),
    entryRef: trade.entryRef,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    sl: trade.sl,
    tp: trade.tp,
    partialTarget: trade.partialTarget,
    plannedRR: trade.plannedRR,
    plannedRisk: trade.plannedRisk,
    realizedPnL: trade.realizedPnL,
    realizedR: trade.realizedR,
    exitReason: trade.exitReason,
    durationMinutes: trade.durationMinutes,
    barsHeld: trade.barsHeld,
    usedFallback: trade.usedFallback,
  };
}

function markdownReport(summary) {
  const assumptions = [
    "Entry is taken at the close of the candle where strategyEngine returns ENTER.",
    "Open trades are processed before the next strategy evaluation, matching the live tick flow.",
    "Because only M5 OHLC is available, intrabar movement is simulated as open-low-high-close for bullish candles and open-high-low-close for bearish candles.",
    `Spread is modeled as ${SPREAD} full price units and slippage as ${SLIPPAGE} adverse price units per fill.`,
    `Entry mode is ${ENTRY_MODE}${MIN_SCORE == null ? "" : ` with minimum score ${MIN_SCORE}`}.`,
    "Commission, swap, and broker rejections are not included.",
    `PnL uses contract size ${CONTRACT_SIZE} and total lot ${TOTAL_LOT}.`,
  ];

  const recentTrades = closedTrades.slice(-10).map((trade) => {
    return `| ${trade.id} | ${trade.side} | ${iso(trade.entryTime)} | ${iso(
      trade.exitTime,
    )} | ${trade.exitReason} | ${num(trade.realizedR, 2)} | ${money(
      trade.realizedPnL,
    )} |`;
  });

  return [
    "# Backtest Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Symbol: ${summary.symbol}`,
    `Data: ${summary.dataFile}`,
    `Range: ${summary.from} to ${summary.to}`,
    `Candles: ${summary.candlesLoaded}`,
    "",
    "## Assumptions",
    "",
    ...assumptions.map((item) => `- ${item}`),
    "",
    "## Summary",
    "",
    `- Entry signals seen: ${summary.trades.signals}`,
    `- Total trades taken: ${summary.trades.total}`,
    `- Filtered entries: ${summary.trades.filteredEntries} (mode: ${summary.trades.filteredByMode}, score: ${summary.trades.filteredByScore})`,
    `- Behavioral / Behavioral+Score / Score-only entries: ${
      summary.trades.entryReasons.BEHAVIORAL || 0
    } / ${summary.trades.entryReasons.BEHAVIORAL_AND_SCORE || 0} / ${
      summary.trades.entryReasons.SCORE || 0
    }`,
    `- BUY / SELL: ${summary.trades.buy} / ${summary.trades.sell}`,
    `- Wins / Losses / Breakeven: ${summary.trades.wins} / ${summary.trades.losses} / ${summary.trades.breakeven}`,
    `- TP / SL / Break-even exits: ${summary.trades.exitReasons.TP_HIT || 0} / ${
      summary.trades.exitReasons.STOP_LOSS || 0
    } / ${summary.trades.exitReasons.BREAK_EVEN || 0}`,
    `- Win rate: ${pct(summary.trades.winRate)}`,
    `- Net profit: ${money(summary.pnl.netProfit)}`,
    `- Gross profit: ${money(summary.pnl.grossProfit)}`,
    `- Gross loss: ${money(summary.pnl.grossLoss)}`,
    `- Profit factor: ${num(summary.pnl.profitFactor, 2)}`,
    `- Expectancy per trade: ${money(summary.pnl.expectancy)}`,
    `- Average planned TP:SL RR: ${num(summary.risk.averagePlannedRR, 2)}`,
    `- Average realized R: ${num(summary.risk.averageRealizedR, 2)}`,
    `- Total realized R: ${num(summary.risk.totalRealizedR, 2)}`,
    `- Max drawdown: ${money(summary.risk.maxDrawdown)} (${pct(
      summary.risk.maxDrawdownPct,
    )})`,
    `- Ending balance: ${money(summary.settings.endingBalance)}`,
    `- Average duration: ${num(summary.duration.averageMinutes, 1)} minutes (${num(
      summary.duration.averageBars,
      1,
    )} M5 bars)`,
    `- Forced end-of-data exits: ${summary.trades.forcedExits}`,
    `- Fallback SL/TP entries: ${summary.trades.fallbackSltp}`,
    "",
    "## Recent Trades",
    "",
    "| ID | Side | Entry Time | Exit Time | Exit | R | PnL |",
    "| --- | --- | --- | --- | --- | ---: | ---: |",
    ...(recentTrades.length ? recentTrades : ["| N/A | N/A | N/A | N/A | N/A | N/A | N/A |"]),
    "",
  ].join("\n");
}

function writeReports(candles) {
  const summary = createSummary(candles);
  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    trades: closedTrades.map(serializeTrade),
    equityEvents,
  };

  fs.writeFileSync(REPORT_JSON_FILE, JSON.stringify(report, null, 2));
  fs.writeFileSync(REPORT_MD_FILE, markdownReport(summary));

  return summary;
}

function printSummary(summary) {
  const lines = [
    "",
    "====================",
    "Backtest Complete",
    "====================",
    `Symbol: ${summary.symbol}`,
    `Range: ${summary.from} -> ${summary.to}`,
    `Spread / Slippage: ${summary.settings.spread} / ${summary.settings.slippage}`,
    `Entry Mode / Min Score: ${summary.settings.entryMode} / ${
      summary.settings.minScore ?? "none"
    }`,
    `Candles Processed: ${summary.candlesLoaded}`,
    `Entry Signals Seen: ${summary.trades.signals}`,
    `Total trades taken: ${summary.trades.total}`,
    `Filtered Entries: ${summary.trades.filteredEntries}`,
    `BUY / SELL: ${summary.trades.buy} / ${summary.trades.sell}`,
    `Wins / Losses / BE: ${summary.trades.wins} / ${summary.trades.losses} / ${summary.trades.breakeven}`,
    `Win Rate: ${pct(summary.trades.winRate)}`,
    `Net Profit: ${money(summary.pnl.netProfit)}`,
    `Profit Factor: ${num(summary.pnl.profitFactor, 2)}`,
    `Average Planned RR: ${num(summary.risk.averagePlannedRR, 2)}`,
    `Average Realized R: ${num(summary.risk.averageRealizedR, 2)}`,
    `Max Drawdown: ${money(summary.risk.maxDrawdown)} (${pct(
      summary.risk.maxDrawdownPct,
    )})`,
    `Ending Balance: ${money(summary.settings.endingBalance)}`,
    `Report: ${REPORT_MD_FILE}`,
    `JSON: ${REPORT_JSON_FILE}`,
    `Logs: ${LOG_FILE}`,
    "",
  ];

  process.stdout.write(lines.join("\n"));
}

// =========================
// BACKTEST LOGGER
// =========================

fs.writeFileSync(LOG_FILE, "");

global.backtestLogger = {
  write(event) {
    try {
      const timestamp = new Date(event.timestamp).toISOString();
      const line = `[${timestamp}] ${event.from || "UNKNOWN"} -> ${
        event.to || "UNKNOWN"
      } ${event.signal || ""} ${event.price || ""}\n`;

      fs.appendFileSync(LOG_FILE, line);
    } catch (err) {
      process.stdout.write(`\nLogger Error: ${err.message}\n`);
    }
  },
};

// =========================
// REPLAY LOOP
// =========================

const candles = loadCandles(DATA_FILE);

process.stdout.write("\nStarting Exness-style Replay...\n");
process.stdout.write(`Candles Loaded: ${candles.length}\n`);
process.stdout.write(`Initial Balance: ${money(INITIAL_BALANCE)}\n`);
process.stdout.write(`Lot: ${TOTAL_LOT} | Contract Size: ${CONTRACT_SIZE}\n`);
process.stdout.write(`Spread: ${SPREAD} | Slippage: ${SLIPPAGE}\n\n`);
process.stdout.write(
  `Entry Mode: ${ENTRY_MODE} | Min Score: ${MIN_SCORE ?? "none"}\n\n`,
);

for (const candle of candles) {
  processOpenTradesForCandle(candle);
  replayCandleIntoContext(candle);

  if (ctx.candles.m15.length < 200 || ctx.candles.m5.length < 50) {
    continue;
  }

  const result = strategyEngine(ctx);

  if (result?.action === "ENTER") {
    counters.entrySignals += 1;

    if (shouldTakeEntry(result)) {
      createTrade(result.signal, result.score, candle, result.entry);
    } else {
      fs.appendFileSync(
        LOG_FILE,
        `[${new Date(candle.time).toISOString()}] FILTERED ${result.signal} score=${Number(
          result.score || 0,
        ).toFixed(2)} reason=${result.entry?.reason || "UNKNOWN"}\n`,
      );
    }

    resetStrategyEngine();
  }
}

if (candles.length) {
  forceCloseOpenTrades(candles[candles.length - 1]);
}

const summary = writeReports(candles);
printSummary(summary);
