const { getContext } = require('./symbolRegistry');

const MAX_CANDLES = 500;

function updateCandles(symbol, bid, ask, timestamp) {
  const ctx = getContext(symbol);
  if (!ctx) return;

  const price = (bid + ask) / 2;

  buildCandle(ctx.candles.m1, timestamp, 60_000, price);
  buildCandle(ctx.candles.m5, timestamp, 300_000, price);
  buildCandle(ctx.candles.m15, timestamp, 900_000, price);
}

function buildCandle(store, timestamp, interval, price) {
  const bucket = Math.floor(timestamp / interval) * interval;

  let last = store[store.length - 1];

  if (!last || last.time !== bucket) {
    store.push({
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price
    });

    if (store.length > MAX_CANDLES) {
      store.shift();
    }

    return;
  }

  last.high = Math.max(last.high, price);
  last.low = Math.min(last.low, price);
  last.close = price;
}

module.exports = {
  updateCandles
};