// aggregator.js
const TIMEFRAMES = { '1m': 60, '5m': 300, '30m': 1800 };

class CandleAggregator {
  constructor(symbol, maxCandles = 400) {
    this.symbol = symbol;
    this.maxCandles = maxCandles;
    this.candles = { '1m': [], '5m': [], '30m': [] };
    this.current = { '1m': null, '5m': null, '30m': null };
  }

  getBucket(timestamp, tf) {
    const sec = TIMEFRAMES[tf];
    return Math.floor(timestamp / sec) * sec;
  }

  update(tick) {
    const mid = (tick.bid + tick.ask) / 2;
    const ts = Math.floor(new Date(tick.time).getTime() / 1000);

    for (const tf of Object.keys(TIMEFRAMES)) {
      const bucket = this.getBucket(ts, tf);
      const current = this.current[tf];
      if (!current || current.timestamp !== bucket) {
        // finalize previous candle
        if (current) this._finalize(tf, current);
        // start new
        this.current[tf] = { timestamp: bucket, open: mid, high: mid, low: mid, close: mid };
      } else {
        // update current
        current.close = mid;
        if (mid > current.high) current.high = mid;
        if (mid < current.low) current.low = mid;
      }
    }
  }

  _finalize(tf, candle) {
    const arr = this.candles[tf];
    arr.push(candle);
    if (arr.length > this.maxCandles) arr.shift();
  }

  getArrays(tf) {
    const arr = this.candles[tf];
    return {
      high: arr.map(c => c.high),
      low: arr.map(c => c.low),
      close: arr.map(c => c.close),
      open: arr.map(c => c.open)
    };
  }

  getLastClosed(tf) {
    const arr = this.candles[tf];
    return arr.length > 0 ? arr[arr.length - 1] : null;
  }
}

module.exports = CandleAggregator;
