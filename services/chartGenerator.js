const { createCanvas } = require("canvas");

const WIDTH = 1280;
const HEIGHT = 720;

const COLORS = {
  background: "#0f131a",
  chart: "#131722",
  grid: "rgba(67, 70, 81, 0.38)",
  gridSoft: "rgba(67, 70, 81, 0.22)",
  axis: "#2a2e39",
  text: "#d1d4dc",
  muted: "#787b86",
  green: "#26a69a",
  greenSoft: "rgba(38, 166, 154, 0.38)",
  red: "#ef5350",
  redSoft: "rgba(239, 83, 80, 0.38)",
  blue: "#2962ff",
  white: "#e5e7eb",
  amber: "#f5c542",
  purple: "#b388ff",
};

const PLOT = {
  left: 70,
  top: 74,
  right: 1080,
  bottom: 604,
};

const PRICE_AXIS_LEFT = PLOT.right;
const PRICE_AXIS_RIGHT = WIDTH - 28;
const TIME_AXIS_TOP = PLOT.bottom;
const TIME_AXIS_BOTTOM = HEIGHT - 42;
const LEVEL_LABEL_HEIGHT = 34;
const LEVEL_LABEL_GAP = 7;
const LEVEL_LABEL_FONT = "bold 17px Arial";

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCandle(candle) {
  return {
    time: candle.time || candle.Time || candle.date || candle.Date || "",
    open: toNumber(candle.open ?? candle.Open),
    high: toNumber(candle.high ?? candle.High),
    low: toNumber(candle.low ?? candle.Low),
    close: toNumber(candle.close ?? candle.Close),
    volume: toNumber(candle.volume ?? candle.Volume) ?? 0,
  };
}

function formatPrice(price) {
  return Number(price).toFixed(2);
}

function formatEvent(event) {
  return String(event || "").replace(/_/g, " ");
}

function formatTime(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{2}:\d{2}/.test(value)) {
    return value.slice(0, 5);
  }

  const text = String(value);
  const normalized = text.replace(
    /^(\d{4})\.(\d{2})\.(\d{2})/,
    "$1-$2-$3",
  );
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 5);

  return date.toISOString().slice(11, 16);
}

function roundNice(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;

  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  let niceFraction = 1;

  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;

  return niceFraction * 10 ** exponent;
}

function getPriceRange(candles, levels) {
  const prices = [];

  for (const candle of candles) {
    if (Number.isFinite(candle.high)) prices.push(candle.high);
    if (Number.isFinite(candle.low)) prices.push(candle.low);
  }

  for (const level of levels) {
    if (Number.isFinite(level)) prices.push(level);
  }

  if (!prices.length) {
    return { minPrice: 0, maxPrice: 1 };
  }

  let minPrice = Math.min(...prices);
  let maxPrice = Math.max(...prices);
  let range = maxPrice - minPrice;

  if (range <= 0) {
    range = Math.max(1, Math.abs(maxPrice) * 0.002);
    minPrice -= range;
    maxPrice += range;
  }

  const padding = Math.max(range * 0.14, 0.5);

  return {
    minPrice: minPrice - padding,
    maxPrice: maxPrice + padding,
  };
}

function priceToY(price, minPrice, maxPrice) {
  const chartHeight = PLOT.bottom - PLOT.top;
  return PLOT.bottom - ((price - minPrice) / (maxPrice - minPrice)) * chartHeight;
}

function xForIndex(index, candleWidth) {
  return PLOT.left + index * candleWidth + candleWidth / 2;
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawText(ctx, text, x, y, options = {}) {
  ctx.save();
  ctx.fillStyle = options.color || COLORS.text;
  ctx.font = options.font || "18px Arial";
  ctx.textAlign = options.align || "left";
  ctx.textBaseline = options.baseline || "alphabetic";
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawBackground(ctx) {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = COLORS.chart;
  ctx.fillRect(PLOT.left, PLOT.top, PLOT.right - PLOT.left, PLOT.bottom - PLOT.top);
  ctx.fillRect(PRICE_AXIS_LEFT, PLOT.top, PRICE_AXIS_RIGHT - PRICE_AXIS_LEFT, PLOT.bottom - PLOT.top);
  ctx.fillRect(PLOT.left, TIME_AXIS_TOP, PLOT.right - PLOT.left, TIME_AXIS_BOTTOM - TIME_AXIS_TOP);

  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.strokeRect(PLOT.left, PLOT.top, PLOT.right - PLOT.left, PLOT.bottom - PLOT.top);

  ctx.beginPath();
  ctx.moveTo(PRICE_AXIS_LEFT, PLOT.top);
  ctx.lineTo(PRICE_AXIS_LEFT, TIME_AXIS_BOTTOM);
  ctx.moveTo(PLOT.left, TIME_AXIS_TOP);
  ctx.lineTo(PRICE_AXIS_RIGHT, TIME_AXIS_TOP);
  ctx.stroke();
}

function drawHeader(ctx, { side, event, entryPrice, stopLoss, takeProfit, candles }) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const change = last.close - prev.close;
  const changeColor = change >= 0 ? COLORS.green : COLORS.red;

  drawText(ctx, `${side} XAUUSD | ${formatEvent(event)}`, 32, 32, {
    color: COLORS.white,
    font: "bold 24px Arial",
  });

  drawText(ctx, "5m", 32, 56, {
    color: COLORS.muted,
    font: "16px Arial",
  });

  drawText(ctx, `O ${formatPrice(last.open)}  H ${formatPrice(last.high)}  L ${formatPrice(last.low)}  C ${formatPrice(last.close)}`, 84, 56, {
    color: changeColor,
    font: "16px Arial",
  });

  drawText(ctx, `Entry ${formatPrice(entryPrice)}    TP ${formatPrice(takeProfit)}    SL ${formatPrice(stopLoss)}`, WIDTH - 32, 32, {
    align: "right",
    color: COLORS.muted,
    font: "16px Arial",
  });
}

function drawPriceGrid(ctx, minPrice, maxPrice) {
  const desiredLines = 9;
  const rawStep = (maxPrice - minPrice) / desiredLines;
  const step = roundNice(rawStep);
  const first = Math.ceil(minPrice / step) * step;

  ctx.save();
  ctx.lineWidth = 1;

  for (let price = first; price <= maxPrice + step * 0.5; price += step) {
    const y = priceToY(price, minPrice, maxPrice);
    if (y < PLOT.top || y > PLOT.bottom) continue;

    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(PLOT.left, y);
    ctx.lineTo(PLOT.right, y);
    ctx.stroke();

    drawText(ctx, formatPrice(price), PRICE_AXIS_LEFT + 12, y, {
      color: COLORS.muted,
      font: "15px Arial",
      baseline: "middle",
    });
  }

  ctx.restore();
}

function drawTimeGrid(ctx, candles, candleWidth) {
  const labels = 7;
  const step = Math.max(1, Math.floor(candles.length / labels));

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.gridSoft;

  for (let i = 0; i < candles.length; i += step) {
    const x = xForIndex(i, candleWidth);

    ctx.beginPath();
    ctx.moveTo(x, PLOT.top);
    ctx.lineTo(x, PLOT.bottom);
    ctx.stroke();

    drawText(ctx, formatTime(candles[i].time), x, TIME_AXIS_TOP + 24, {
      align: "center",
      color: COLORS.muted,
      font: "14px Arial",
    });
  }

  ctx.restore();
}

function drawVolume(ctx, candles, candleWidth) {
  const top = PLOT.bottom - 82;
  const bottom = PLOT.bottom - 10;
  const maxVolume = Math.max(...candles.map((c) => c.volume || 0), 1);

  ctx.save();

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const x = PLOT.left + i * candleWidth + Math.max(1, candleWidth * 0.14);
    const width = Math.max(1, candleWidth * 0.72);
    const height = ((candle.volume || 0) / maxVolume) * (bottom - top);
    const bullish = candle.close >= candle.open;

    ctx.fillStyle = bullish ? COLORS.greenSoft : COLORS.redSoft;
    ctx.fillRect(x, bottom - height, width, height);
  }

  ctx.restore();
}

function calculateEma(candles, period) {
  const alpha = 2 / (period + 1);
  const result = [];
  let ema = null;

  for (const candle of candles) {
    ema = ema == null ? candle.close : candle.close * alpha + ema * (1 - alpha);
    result.push(ema);
  }

  return result;
}

function drawLineSeries(ctx, values, candleWidth, minPrice, maxPrice, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();

  let started = false;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;

    const x = xForIndex(i, candleWidth);
    const y = priceToY(value, minPrice, maxPrice);

    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
  ctx.restore();
}

function drawCandles(ctx, candles, candleWidth, minPrice, maxPrice) {
  const bodyWidth = Math.max(3, Math.min(12, candleWidth * 0.7));

  ctx.save();
  ctx.lineWidth = 1.4;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const x = xForIndex(i, candleWidth);
    const openY = priceToY(candle.open, minPrice, maxPrice);
    const closeY = priceToY(candle.close, minPrice, maxPrice);
    const highY = priceToY(candle.high, minPrice, maxPrice);
    const lowY = priceToY(candle.low, minPrice, maxPrice);
    const bullish = candle.close >= candle.open;
    const color = bullish ? COLORS.green : COLORS.red;
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(2, Math.abs(closeY - openY));

    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  }

  ctx.restore();
}

function drawPriceLabel(ctx, y, color, text, anchorY = y) {
  const x = PRICE_AXIS_LEFT + 10;
  const height = LEVEL_LABEL_HEIGHT;
  const width = PRICE_AXIS_RIGHT - x;

  ctx.save();

  if (Math.abs(anchorY - y) > 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(PRICE_AXIS_LEFT + 1, anchorY);
    ctx.lineTo(x - 2, y);
    ctx.stroke();
  }

  ctx.fillStyle = color;
  drawRoundedRect(ctx, x, y - height / 2, width, height, 5);
  ctx.fill();

  drawText(ctx, text, x + width / 2, y, {
    align: "center",
    baseline: "middle",
    color: "#ffffff",
    font: LEVEL_LABEL_FONT,
  });
  ctx.restore();
}

function drawLevelLine(ctx, price, color, minPrice, maxPrice, dashed = false) {
  const y = priceToY(price, minPrice, maxPrice);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  if (dashed) ctx.setLineDash([8, 6]);

  ctx.beginPath();
  ctx.moveTo(PLOT.left, y);
  ctx.lineTo(PLOT.right, y);
  ctx.stroke();
  ctx.restore();

  return y;
}

function drawCurrentPriceLine(ctx, price, minPrice, maxPrice) {
  const y = priceToY(price, minPrice, maxPrice);

  ctx.save();
  ctx.strokeStyle = COLORS.amber;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.moveTo(PLOT.left, y);
  ctx.lineTo(PLOT.right, y);
  ctx.stroke();
  ctx.restore();

  return y;
}

function samePrice(a, b, minPrice, maxPrice) {
  return Math.abs(a - b) <= Math.max((maxPrice - minPrice) * 0.0015, 0.01);
}

function getStopLevelLabel(event, entryPrice, stopLoss, minPrice, maxPrice) {
  const beEvents = new Set(["PARTIAL", "BREAK_EVEN", "TP"]);

  if (
    beEvents.has(String(event || "").toUpperCase()) &&
    samePrice(entryPrice, stopLoss, minPrice, maxPrice)
  ) {
    return "BE";
  }

  return "SL";
}

function layoutLevelLabels(labels) {
  const minY = PLOT.top + LEVEL_LABEL_HEIGHT / 2 + 4;
  const maxY = PLOT.bottom - LEVEL_LABEL_HEIGHT / 2 - 4;
  const step = LEVEL_LABEL_HEIGHT + LEVEL_LABEL_GAP;
  const sorted = labels
    .filter((label) => Number.isFinite(label.price) && Number.isFinite(label.anchorY))
    .sort((a, b) => a.anchorY - b.anchorY)
    .map((label) => ({
      ...label,
      labelY: Math.min(maxY, Math.max(minY, label.anchorY)),
    }));

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].labelY < sorted[i - 1].labelY + step) {
      sorted[i].labelY = sorted[i - 1].labelY + step;
    }
  }

  if (sorted.length) {
    const overflow = sorted[sorted.length - 1].labelY - maxY;
    if (overflow > 0) {
      for (const label of sorted) {
        label.labelY -= overflow;
      }
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].labelY < sorted[i - 1].labelY + step) {
      sorted[i].labelY = sorted[i - 1].labelY + step;
    }
  }

  return sorted;
}

function drawTradeLevels(ctx, { event, entry, sl, tp, lastClose, minPrice, maxPrice }) {
  const stopLabel = getStopLevelLabel(event, entry, sl, minPrice, maxPrice);
  const levels = [
    { price: tp, color: COLORS.blue, label: "TP", dashed: false },
    { price: entry, color: COLORS.white, label: "ENTRY", dashed: true },
    {
      price: sl,
      color: stopLabel === "BE" ? COLORS.amber : COLORS.red,
      label: stopLabel,
      dashed: false,
    },
  ];

  const labels = [];

  for (const level of levels) {
    const anchorY = drawLevelLine(
      ctx,
      level.price,
      level.color,
      minPrice,
      maxPrice,
      level.dashed,
    );

    labels.push({
      ...level,
      anchorY,
      text: `${level.label} ${formatPrice(level.price)}`,
    });
  }

  labels.push({
    price: lastClose,
    color: COLORS.amber,
    label: "PRICE",
    anchorY: drawCurrentPriceLine(ctx, lastClose, minPrice, maxPrice),
    text: formatPrice(lastClose),
  });

  for (const label of layoutLevelLabels(labels)) {
    drawPriceLabel(ctx, label.labelY, label.color, label.text, label.anchorY);
  }
}

function drawWatermark(ctx) {
  drawText(ctx, "XAUUSD", PLOT.left + 28, PLOT.top + 70, {
    color: "rgba(209, 212, 220, 0.08)",
    font: "bold 86px Arial",
  });
}

async function generateTradeChart({
  candles = [],
  side,
  event,
  pairId,
  entryPrice,
  stopLoss,
  takeProfit,
}) {
  const normalizedCandles = candles
    .map(normalizeCandle)
    .filter((c) =>
      [c.open, c.high, c.low, c.close].every((value) => Number.isFinite(value)),
    );

  if (!normalizedCandles.length) {
    throw new Error("No candles supplied to chart generator");
  }

  const entry = toNumber(entryPrice);
  const sl = toNumber(stopLoss);
  const tp = toNumber(takeProfit);

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const { maxPrice, minPrice } = getPriceRange(normalizedCandles, [entry, sl, tp]);
  const candleWidth = (PLOT.right - PLOT.left) / normalizedCandles.length;
  const lastClose = normalizedCandles[normalizedCandles.length - 1].close;

  drawBackground(ctx);
  drawHeader(ctx, {
    side,
    event,
    pairId,
    entryPrice: entry,
    stopLoss: sl,
    takeProfit: tp,
    candles: normalizedCandles,
  });
  drawPriceGrid(ctx, minPrice, maxPrice);
  drawTimeGrid(ctx, normalizedCandles, candleWidth);
  drawWatermark(ctx);
  drawVolume(ctx, normalizedCandles, candleWidth);
  drawLineSeries(ctx, calculateEma(normalizedCandles, 20), candleWidth, minPrice, maxPrice, COLORS.amber);
  drawLineSeries(ctx, calculateEma(normalizedCandles, 50), candleWidth, minPrice, maxPrice, COLORS.purple);
  drawCandles(ctx, normalizedCandles, candleWidth, minPrice, maxPrice);

  drawTradeLevels(ctx, {
    event,
    entry,
    sl,
    tp,
    lastClose,
    minPrice,
    maxPrice,
  });

  drawText(ctx, `Pair: ${pairId || "XAUUSD"}    Candles: ${normalizedCandles.length}    EMA 20 / EMA 50`, 32, HEIGHT - 18, {
    color: COLORS.muted,
    font: "15px Arial",
  });

  return canvas.toBuffer("image/png");
}

module.exports = {
  generateTradeChart,
};
