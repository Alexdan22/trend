const { createCanvas } = require("canvas");

const WIDTH = 1024;
const HEIGHT = 576;
const PLOT = Object.freeze({ left: 74, top: 24, right: WIDTH - 24, bottom: HEIGHT - 54 });

function formatUtc(timestamp) {
  const date = new Date(timestamp);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function renderCleanCandlestickChart(candles, timeframe) {
  if (!Array.isArray(candles) || !candles.length) throw new Error(`No ${timeframe} candles available`);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  context.fillStyle = "#0b1220";
  context.fillRect(0, 0, WIDTH, HEIGHT);

  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const padding = Math.max((max - min) * 0.06, max * 0.0002, 0.01);
  min -= padding;
  max += padding;
  const xStep = (PLOT.right - PLOT.left) / candles.length;
  const y = (price) => PLOT.bottom - ((price - min) / (max - min)) * (PLOT.bottom - PLOT.top);

  context.strokeStyle = "#263449";
  context.fillStyle = "#9fb0c8";
  context.font = "12px sans-serif";
  context.lineWidth = 1;
  for (let index = 0; index <= 5; index++) {
    const py = PLOT.top + ((PLOT.bottom - PLOT.top) * index) / 5;
    const price = max - ((max - min) * index) / 5;
    context.beginPath(); context.moveTo(PLOT.left, py); context.lineTo(PLOT.right, py); context.stroke();
    context.fillText(price.toFixed(2), 8, py + 4);
  }

  const bodyWidth = Math.max(2, Math.min(9, xStep * 0.65));
  candles.forEach((candle, index) => {
    const x = PLOT.left + xStep * (index + 0.5);
    const rising = candle.close >= candle.open;
    context.strokeStyle = rising ? "#3ddc97" : "#ff6b6b";
    context.fillStyle = context.strokeStyle;
    context.beginPath(); context.moveTo(x, y(candle.high)); context.lineTo(x, y(candle.low)); context.stroke();
    const top = Math.min(y(candle.open), y(candle.close));
    const height = Math.max(1, Math.abs(y(candle.open) - y(candle.close)));
    context.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
  });

  const labelEvery = Math.max(1, Math.floor(candles.length / 8));
  candles.forEach((candle, index) => {
    if (index % labelEvery !== 0 && index !== candles.length - 1) return;
    const x = PLOT.left + xStep * (index + 0.5);
    context.fillStyle = "#9fb0c8";
    context.fillText(formatUtc(candle.timestamp), Math.min(x - 18, PLOT.right - 38), HEIGHT - 26);
  });
  context.fillStyle = "#d9e2ef";
  context.font = "bold 13px sans-serif";
  context.fillText(`${timeframe.toUpperCase()} · UTC`, PLOT.left, 16);
  return canvas.toBuffer("image/png");
}

module.exports = { HEIGHT, WIDTH, renderCleanCandlestickChart };
