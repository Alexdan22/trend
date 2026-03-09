/*
Market Hours Guard

Blocks trading during low-liquidity periods
such as daily rollover.
*/

function checkMarketHours() {

  const now = new Date();

  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();

  const minutes = utcHour * 60 + utcMinute;

  const rolloverStart = 21 * 60 + 55; // 21:55 UTC
  const rolloverEnd = 22 * 60 + 10;   // 22:10 UTC

  if (minutes >= rolloverStart && minutes <= rolloverEnd) {
    return false;
  }

  return true;
}

module.exports = {
  checkMarketHours
};