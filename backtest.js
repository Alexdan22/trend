process.env.ENGINE_MODE = "BACKTEST";

const fs = require('fs');
const path = require('path');

const {
  strategyEngine
} = require('./src/strategy/strategyEngine');

const {
  initSymbol,
  getContext,
  updatePrice
} = require('./src/core/symbolRegistry');


// =========================
// INDICATOR HELPERS
// =========================

function calculateEMA(values, period) {

  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let ema =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

function calculateRSI(values, period = 14) {

  if (values.length < period + 1) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  if (losses === 0) return 100;

  const rs = gains / losses;

  return 100 - (100 / (1 + rs));
}

function calculateSMA(values, period) {

  if (values.length < period) {
    return null;
  }

  const slice = values.slice(-period);

  return (
    slice.reduce((a, b) => a + b, 0)
    / period
  );
}

function calculateStdDev(values, period) {

  if (values.length < period) {
    return null;
  }

  const slice = values.slice(-period);

  const mean =
    calculateSMA(values, period);

  const variance =
    slice.reduce(
      (s, v) => s + Math.pow(v - mean, 2),
      0
    ) / period;

  return Math.sqrt(variance);
}

function calculateBollingerBands(
  values,
  period = 20,
  mult = 2
) {

  const mid =
    calculateSMA(values, period);

  const std =
    calculateStdDev(values, period);

  if (mid == null || std == null) {
    return null;
  }

  return {
    upper: mid + mult * std,
    lower: mid - mult * std,
    middle: mid,
    width: (2 * mult * std) / mid
  };
}

function calculateStochastic(
  candles,
  period = 14
) {

  if (candles.length < period) {
    return null;
  }

  const slice =
    candles.slice(-period);

  const highs =
    slice.map(c => c.high);

  const lows =
    slice.map(c => c.low);

  const highestHigh =
    Math.max(...highs);

  const lowestLow =
    Math.min(...lows);

  const lastClose =
    slice[slice.length - 1].close;

  if (highestHigh === lowestLow) {
    return null;
  }

  return (
    (
      lastClose - lowestLow
    ) /
    (
      highestHigh - lowestLow
    )
  ) * 100;
}

function computeATR_M5(
  candles,
  period = 14
) {

  if (candles.length < period + 1) {
    return null;
  }

  const start =
    candles.length - period;

  const trs = [];

  for (
    let i = start;
    i < candles.length;
    i++
  ) {

    const curr = candles[i];
    const prev = candles[i - 1];

    const highLow =
      curr.high - curr.low;

    const highClose =
      Math.abs(curr.high - prev.close);

    const lowClose =
      Math.abs(curr.low - prev.close);

    trs.push(
      Math.max(
        highLow,
        highClose,
        lowClose
      )
    );
  }

  return (
    trs.reduce((a, b) => a + b, 0)
    / trs.length
  );
}


// =========================
// CONTEXT INIT
// =========================

const SYMBOL = 'XAUUSD';

initSymbol(SYMBOL);

const ctx = getContext(SYMBOL);

// =========================
// BACKTEST LOGGER
// =========================

const LOG_FILE =
  path.join(
    __dirname,
    'backtest-logs.txt'
  );

fs.writeFileSync(LOG_FILE, '');

global.backtestLogger = {

  write(event) {

    try {

      const timestamp =
        new Date(
          event.timestamp
        ).toISOString();

      const line =
        `[${timestamp}] `
        + `${event.from || 'UNKNOWN'} `
        + `-> `
        + `${event.to || 'UNKNOWN'} `
        + `${event.signal || ''} `
        + `${event.price || ''}\n`;

      fs.appendFileSync(
        LOG_FILE,
        line
      );

    } catch (err) {

      process.stdout.write(
        `\nLogger Error: ${err.message}\n`
      );

    }

  }

};


// =========================
// LOAD HISTORICAL DATA
// =========================

const rawCandles =
  require('./data/XAUUSD_M5.json');

if (!Array.isArray(rawCandles)) {

  throw new Error(
    'Historical data must be an array'
  );

}

process.stdout.write(
  `\nStarting Replay...\n`
);

process.stdout.write(
  `Candles Loaded: ${rawCandles.length}\n\n`
);


// =========================
// REPLAY LOOP
// =========================

for (const rawCandle of rawCandles) {

  const [year, month, day] = rawCandle.Date.split('.');
  const isoDate = `${year}-${month}-${day}T${rawCandle.Time}:00Z`;

  const timestamp = new Date(isoDate).getTime();


  const candle = {
    time: timestamp,

    open: Number(rawCandle.Open),
    high: Number(rawCandle.High),
    low: Number(rawCandle.Low),
    close: Number(rawCandle.Close),

    volume: Number(rawCandle.Volume)
  };

  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  const price = close;


  updatePrice(
    SYMBOL,
    price,
    price,
    candle.time
  );

  ctx.timestamp =
    candle.time;

  ctx.price = {
   bid: price,
   ask: price,
   spread: 0,
   timestamp: candle.time
  };
  ctx.price.timestamp = candle.time;

  // M5
  ctx.candles.m5.push({
    time: candle.time,
    open: open,
    high: high,
    low: low,
    close: close
  });

  // Keep capped
  if (ctx.candles.m5.length > 500) {
    ctx.candles.m5.shift();
  }

  // Build M15 from M5
  const bucket15 =
    Math.floor(
      candle.time / 900000
    ) * 900000;

  let last15 =
    ctx.candles.m15[
      ctx.candles.m15.length - 1
    ];

  if (
    !last15 ||
    last15.time !== bucket15
  ) {

    ctx.candles.m15.push({
      time: bucket15,
      open: open,
      high: high,
      low: low,
      close: close
    });

  } else {

    last15.high =
      Math.max(last15.high, high);

    last15.low =
      Math.min(last15.low, low);

    last15.close =
      close;
  }

  // =========================
  // INDICATORS
  // =========================

  const m5Closes =
    ctx.candles.m5.map(
      c => c.close
    );

  const m15Closes =
    ctx.candles.m15.map(
      c => c.close
    );

  ctx.indicators.rsi =
    calculateRSI(m5Closes, 14);

  ctx.indicators.stochastic =
    calculateStochastic(
      ctx.candles.m5,
      14
    );

  ctx.indicators.ema50 =
    calculateEMA(
      m15Closes,
      50
    );

  ctx.indicators.ema200 =
    calculateEMA(
      m15Closes,
      200
    );

  ctx.indicators.bollinger =
    calculateBollingerBands(
      m5Closes,
      20,
      2
    );

  ctx.indicators.atr =
    computeATR_M5(
      ctx.candles.m5,
      14
    );

  if (
    ctx.indicators.prevStochastic != null &&
    ctx.indicators.stochastic != null
  ) {

    ctx.indicators.stochasticDelta =
      ctx.indicators.stochastic
      -
      ctx.indicators.prevStochastic;
  }

  ctx.indicators.prevStochastic =
    ctx.indicators.stochastic;

  // =========================
  // STRATEGY
  // =========================
  if (
   ctx.candles.m15.length < 200 ||
   ctx.candles.m5.length < 50
  ) {
   continue;
  }
  
  strategyEngine(ctx);
}

process.stdout.write('\n');

process.stdout.write(
  '====================\n'
);

process.stdout.write(
  'Replay Complete\n'
);

process.stdout.write(
  '====================\n'
);

process.stdout.write(
  `Candles Processed: ${rawCandles.length}\n`
);

process.stdout.write(
  `Logs File: ${LOG_FILE}\n`
);

process.stdout.write('\n');