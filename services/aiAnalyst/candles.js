const TIMEFRAMES = Object.freeze({ m1: 60_000, m5: 300_000, m30: 1_800_000 });

function finitePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function genuineRealVolume(source) {
  if (source?.realVolume == null) return null;
  const value = Number(source.realVolume);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizeProviderCandle(source, cutoff = Date.now()) {
  const timestamp = new Date(source?.time ?? source?.timestamp).getTime();
  const open = finitePrice(source?.open);
  const high = finitePrice(source?.high);
  const low = finitePrice(source?.low);
  const close = finitePrice(source?.close);
  if (![timestamp, open, high, low, close].every(Number.isFinite)) return null;
  if (timestamp > cutoff || high < low || high < Math.max(open, close) || low > Math.min(open, close)) return null;

  const candle = { timestamp, open, high, low, close };
  const realVolume = genuineRealVolume(source);
  if (realVolume != null) {
    candle.volume = realVolume;
    candle.volumeProvenance = "UPSTREAM_REAL_VOLUME";
  }
  return candle;
}

function cloneCandle(candle) {
  const copy = {
    timestamp: Number(candle.timestamp),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
  };
  if (candle.volumeProvenance === "UPSTREAM_REAL_VOLUME" && Number.isFinite(Number(candle.volume))) {
    copy.volume = Number(candle.volume);
    copy.volumeProvenance = "UPSTREAM_REAL_VOLUME";
  }
  return Object.freeze(copy);
}

class IndependentCandleBuffer {
  constructor(limits = { m1: 120, m5: 96, m30: 100 }) {
    this.limits = { ...limits };
    this.frames = { m1: [], m5: [], m30: [] };
  }

  ingestTick(tick) {
    const timestamp = new Date(tick?.timestamp ?? tick?.time).getTime();
    const bid = finitePrice(tick?.bid ?? tick?.price);
    const ask = finitePrice(tick?.ask ?? tick?.price);
    const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask);
    if (!Number.isFinite(timestamp) || !Number.isFinite(mid)) return false;
    for (const [frame, duration] of Object.entries(TIMEFRAMES)) this.#upsert(frame, duration, timestamp, mid);
    return true;
  }

  #upsert(frame, duration, timestamp, price) {
    const bucket = Math.floor(timestamp / duration) * duration;
    const rows = this.frames[frame];
    const last = rows.at(-1);
    if (!last || last.timestamp !== bucket) {
      rows.push({ timestamp: bucket, open: price, high: price, low: price, close: price });
    } else {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    }
    while (rows.length > this.limits[frame]) rows.shift();
  }

  loadHistory(frame, candles, cutoff = Date.now()) {
    if (!TIMEFRAMES[frame]) throw new Error(`Unsupported AI candle timeframe: ${frame}`);
    const byTimestamp = new Map(this.frames[frame].map((candle) => [candle.timestamp, candle]));
    for (const source of candles || []) {
      const candle = sanitizeProviderCandle(source, cutoff);
      if (candle) byTimestamp.set(candle.timestamp, candle);
    }
    this.frames[frame] = [...byTimestamp.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-this.limits[frame]);
    return this.frames[frame].length;
  }

  snapshot(cutoff = Date.now()) {
    const output = {};
    for (const frame of Object.keys(TIMEFRAMES)) {
      output[frame] = Object.freeze(
        this.frames[frame].filter((candle) => candle.timestamp <= cutoff).slice(-this.limits[frame]).map(cloneCandle),
      );
    }
    return Object.freeze(output);
  }
}

module.exports = { IndependentCandleBuffer, TIMEFRAMES, genuineRealVolume, sanitizeProviderCandle };
