// core/candleAggregator.js
// Tick → Candle aggregator - CommonJS

const fs = require('fs');
const path = require('path');
const { checkStrategy } = require('./strategy');

const SYMBOL = process.env.SYMBOL || 'XAUUSDm';
const TICK_CACHE_FILE = path.join(__dirname, `../data/tick_cache_${SYMBOL}.json`);

const aggregators = { '1m': null, '5m': null, '30m': null };

const dataBuffers = {
  m1: { closes: [], highs: [], lows: [], time: null },
  m5: { closes: [], highs: [], lows: [], time: null },
  m30: { closes: [], highs: [], lows: [], time: null }
};

function floorTime(date, tf) {
  const d = new Date(date);
  if (tf === '1m') d.setSeconds(0, 0);
  if (tf === '5m') d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  if (tf === '30m') d.setMinutes(Math.floor(d.getMinutes() / 30) * 30, 0, 0);
  return d.getTime();
}

function pushAndTrim(arr, val, max = 400) {
  arr.push(val);
  if (arr.length > max) arr.shift();
}

function handleTick(tick) {
  const mid = (tick.bid + tick.ask) / 2;
  const now = new Date(tick.time);

  // cache tick locally
  try {
    const entry = { bid: tick.bid, ask: tick.ask, time: tick.time };
    let existing = [];
    if (fs.existsSync(TICK_CACHE_FILE)) {
      existing = JSON.parse(fs.readFileSync(TICK_CACHE_FILE, 'utf8'));
    }
    existing.push(entry);
    if (existing.length > 5000) existing.splice(0, existing.length - 5000);
    fs.mkdirSync(path.dirname(TICK_CACHE_FILE), { recursive: true });
    fs.writeFileSync(TICK_CACHE_FILE, JSON.stringify(existing));
  } catch (e) {
    console.warn('[CACHE] Failed to write tick cache:', e.message);
  }

  ['1m', '5m', '30m'].forEach(tf => {
    const bucketTime = floorTime(now, tf);

    if (!aggregators[tf] || aggregators[tf].time !== bucketTime) {
      if (aggregators[tf]) {
        onCandle({
          timeframe: tf,
          open: aggregators[tf].open,
          high: aggregators[tf].high,
          low: aggregators[tf].low,
          close: aggregators[tf].close,
          time: new Date(aggregators[tf].time).toISOString()
        });
      }
      aggregators[tf] = { time: bucketTime, open: mid, high: mid, low: mid, close: mid };
    } else {
      aggregators[tf].close = mid;
      if (mid > aggregators[tf].high) aggregators[tf].high = mid;
      if (mid < aggregators[tf].low) aggregators[tf].low = mid;
    }
  });
}

async function onCandle(candle) {
  const { timeframe, high, low, close } = candle;
  const buf = timeframe === '1m' ? dataBuffers.m1 : timeframe === '5m' ? dataBuffers.m5 : dataBuffers.m30;

  pushAndTrim(buf.closes, close);
  pushAndTrim(buf.highs, high);
  pushAndTrim(buf.lows, low);
  buf.time = candle.time;

  if (dataBuffers.m1.closes.length >= 30 && dataBuffers.m5.closes.length >= 30 && dataBuffers.m30.closes.length >= 30) {
    await checkStrategy({
      m1: dataBuffers.m1,
      m5: dataBuffers.m5,
      m30: dataBuffers.m30
    });
  }
}

module.exports = {
  handleTick,
  onCandle,
  dataBuffers
};
