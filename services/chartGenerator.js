const { createCanvas } = require("canvas");

const WIDTH = 1280;
const HEIGHT = 720;

const HEADER_HEIGHT = 60;
const FOOTER_HEIGHT = 60;

const CHART_LEFT = 60;
const PRICE_LABEL_WIDTH = 180;

const CHART_RIGHT =
  WIDTH - PRICE_LABEL_WIDTH;

const CHART_TOP =
  HEADER_HEIGHT + 20;

const CHART_BOTTOM =
  HEIGHT - FOOTER_HEIGHT - 30;

//Helper functions

function getPriceRange(
  candles,
  entryPrice,
  stopLoss,
  takeProfit
) {

  const highs =
    candles.map(c => c.high);

  const lows =
    candles.map(c => c.low);

  let maxPrice = Math.max(
    ...highs,
    entryPrice,
    takeProfit
  );

  let minPrice = Math.min(
    ...lows,
    stopLoss,
    entryPrice
  );

  const padding =
    (maxPrice - minPrice) * 0.10;

  maxPrice += padding;
  minPrice -= padding;

  return {
    maxPrice,
    minPrice
  };
}

function priceToY(
  price,
  minPrice,
  maxPrice
) {

  const usableHeight =
    CHART_BOTTOM - CHART_TOP;

  return (
    CHART_BOTTOM -
    (
      (price - minPrice) /
      (maxPrice - minPrice)
    ) *
    usableHeight
  );
}

function drawLevel(
  ctx,
  price,
  color,
  label,
  minPrice,
  maxPrice
) {

  const y = priceToY(
    price,
    minPrice,
    maxPrice
  );

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;

  ctx.beginPath();

  ctx.moveTo(
    CHART_LEFT,
    y
  );

  ctx.lineTo(
    WIDTH - 20,
    y
  );

  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = "bold 16px Arial";

  ctx.fillText(
    `${label} ${price.toFixed(2)}`,
    CHART_RIGHT + 15,
    y - 8
  );
}

async function generateTradeChart({
  candles = [],
  side,
  event,
  pairId,
  entryPrice,
  stopLoss,
  takeProfit
}) {

  const canvas = createCanvas(
    WIDTH,
    HEIGHT
  );

  const ctx = canvas.getContext("2d");

  // =========================
  // Background
  // =========================

  ctx.fillStyle = "#111827";
  ctx.fillRect(
    0,
    0,
    WIDTH,
    HEIGHT
  );

  // =========================
  // Header
  // =========================

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px Arial";

  ctx.fillText(
    `${side} XAUUSD | ${event}`,
    30,
    40
  );

  // =========================
  // Chart Area Placeholder
  // =========================

  ctx.strokeStyle = "#374151";
  ctx.lineWidth = 2;

  ctx.strokeRect(
    CHART_LEFT,
    CHART_TOP,
    CHART_RIGHT - CHART_LEFT,
    CHART_BOTTOM - CHART_TOP
    );

    // =========================
    // Label Area Separator
    // =========================

    ctx.beginPath();

    ctx.strokeStyle = "#374151";
    ctx.lineWidth = 1;

    ctx.moveTo(
    CHART_RIGHT,
    CHART_TOP
    );

    ctx.lineTo(
    CHART_RIGHT,
    CHART_BOTTOM
    );

    ctx.stroke();

  // =========================
  // Price Range Calculation
  // =========================

    const {
        maxPrice,
        minPrice
    } = getPriceRange(
        candles,
        entryPrice,
        stopLoss,
        takeProfit
    );

    const chartWidth =
    CHART_RIGHT - CHART_LEFT;

    if (!candles.length) {
    throw new Error(
        "No candles supplied to chart generator"
    );
    }

    const candleWidth =
    chartWidth / candles.length;

    for (let i = 0; i < candles.length; i++) {

    const candle = candles[i];

    const x =
        CHART_LEFT +
        (i * candleWidth);

    const openY = priceToY(
        candle.open,
        minPrice,
        maxPrice
    );

    const closeY = priceToY(
        candle.close,
        minPrice,
        maxPrice
    );

    const highY = priceToY(
        candle.high,
        minPrice,
        maxPrice
    );

    const lowY = priceToY(
        candle.low,
        minPrice,
        maxPrice
    );

    const bullish =
        candle.close >= candle.open;

    ctx.strokeStyle =
        bullish
        ? "#22c55e"
        : "#ef4444";

    ctx.fillStyle =
        bullish
        ? "#22c55e"
        : "#ef4444";

    // wick

    ctx.beginPath();

    ctx.moveTo(
        x + candleWidth / 2,
        highY
    );

    ctx.lineTo(
        x + candleWidth / 2,
        lowY
    );

    ctx.stroke();

    // body

    const bodyTop =
        Math.min(
        openY,
        closeY
        );

    const bodyHeight =
        Math.max(
        2,
        Math.abs(
            closeY - openY
        )
        );

    ctx.fillRect(
        x + 1,
        bodyTop,
        Math.max(
        2,
        candleWidth - 2
        ),
        bodyHeight
    );
    }

    drawLevel(
    ctx,
    entryPrice,
    "#ffffff",
    "ENTRY",
    minPrice,
    maxPrice
    );

    drawLevel(
    ctx,
    takeProfit,
    "#3b82f6",
    "TP",
    minPrice,
    maxPrice
    );

    drawLevel(
    ctx,
    stopLoss,
    "#ef4444",
    "SL",
    minPrice,
    maxPrice
    );

  // =========================
  // Footer
  // =========================

  ctx.fillStyle = "#ffffff";
  ctx.font = "20px Arial";

  ctx.fillText(
    `Entry: ${entryPrice.toFixed(2)}   TP: ${takeProfit.toFixed(2)}   SL: ${stopLoss.toFixed(2)}`,
    30,
    HEIGHT - 18
  );

  return canvas.toBuffer(
    "image/png"
  );
}

module.exports = {
  generateTradeChart
};