// core/indicators.js
// Technical indicators and market-type detection - CommonJS

const ti = require('technicalindicators');

const STRONG_TREND_BBW = parseFloat(process.env.STRONG_TREND_BBW || '0.035');
const ATR_PERIOD = parseInt(process.env.ATR_PERIOD || '14', 10);

/**
 * Calculates multiple indicators given arrays of closes, highs, and lows.
 * Returns { rsi, stochastic, bb, atr }
 */
function calculateIndicators(closes, highs, lows) {
  const rsi = closes.length >= 14 ? ti.RSI.calculate({ period: 14, values: closes }) : [];
  const stochastic =
    closes.length >= 14 && highs.length >= 14 && lows.length >= 14
      ? ti.Stochastic.calculate({
          period: 14,
          signalPeriod: 3,
          high: highs,
          low: lows,
          close: closes
        })
      : [];
  const bb = closes.length >= 20
    ? ti.BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 })
    : [];
  const atr = closes.length >= ATR_PERIOD
    ? ti.ATR.calculate({ period: ATR_PERIOD, high: highs, low: lows, close: closes })
    : [];
  return { rsi, stochastic, bb, atr };
}

/**
 * Determines whether the market is trending or sideways using Bollinger Bands.
 * Returns "uptrend" | "downtrend" | "sideways"
 */
function determineMarketTypeFromBB(values, bbArray) {
  if (!bbArray.length || !values.length) return 'sideways';

  const lastBB = bbArray[bbArray.length - 1];
  const total = Math.min(values.length, bbArray.length);
  let closeAboveMid = 0;

  for (let i = 0; i < total; i++) {
    if (values[i] > bbArray[i].middle) closeAboveMid++;
  }

  const percentAbove = closeAboveMid / total;
  const bbw = (lastBB.upper - lastBB.lower) / lastBB.middle;

  if (bbw > STRONG_TREND_BBW && percentAbove > 0.6) return 'uptrend';
  if (bbw > STRONG_TREND_BBW && percentAbove < 0.4) return 'downtrend';
  if (bbw > 0.02 && percentAbove > 0.6) return 'uptrend';
  if (bbw > 0.02 && percentAbove < 0.4) return 'downtrend';
  return 'sideways';
}

module.exports = {
  calculateIndicators,
  determineMarketTypeFromBB,
  STRONG_TREND_BBW,
  ATR_PERIOD
};
