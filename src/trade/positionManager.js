/*
Position Manager

Handles position sizing and lot splitting.
*/

const RISK_PERCENT = 0.02;
const LOT_STEP = 0.01;
const MIN_LOT = 0.01;

function calculatePositionSize(accountBalance, stopLossDistance) {

  if (!stopLossDistance || stopLossDistance <= 0) {
    return null;
  }

  const riskAmount = accountBalance * RISK_PERCENT;

  const rawLot = riskAmount / stopLossDistance;

  const normalizedLot = normalizeLot(rawLot);

  if (normalizedLot < MIN_LOT) {
    return null;
  }

  const { volumeA, volumeB } = splitLot(normalizedLot);

  return {
    totalLot: normalizedLot,
    volumeA,
    volumeB
  };
}

function normalizeLot(lot) {

  const normalized = Math.floor(lot / LOT_STEP) * LOT_STEP;

  return parseFloat(normalized.toFixed(2));
}

function splitLot(totalLot) {

  let half = totalLot / 2;

  half = normalizeLot(half);

  if (half < MIN_LOT) {
    half = MIN_LOT;
  }

  const volumeA = half;
  const volumeB = half;

  return {
    volumeA,
    volumeB
  };
}

module.exports = {
  calculatePositionSize
};