// src/execution/orderManager.js

const { registerRecentTicket } = require('../trade/tradeRegistry');

let connection = null;

/*
Allows market adapter to inject broker connection
*/
function setBrokerConnection(conn) {
  connection = conn;
}

/*
Parse broker order response
*/
function parseOrderResponse(res) {

  if (!res) return null;

  try {

    const ticket =
      res?.orderId ||
      res?.positionId ||
      res?.dealId ||
      res?.id ||
      null;

    return {
      ticket: ticket ? String(ticket) : null,
      raw: res
    };

  } catch (err) {

    console.error('[ORDER] Failed parsing response:', err);
    return null;

  }
}

/*
Safe order placement wrapper
*/
async function safePlaceMarketOrder(
  side,
  volume,
  stopLoss,
  takeProfit,
  leg
) {

  if (!connection) {
    throw new Error('Broker connection not initialized');
  }

  try {

    const order = {

      type: side === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',

      symbol: 'XAUUSDm',

      volume: volume,

      stopLoss: stopLoss,

      takeProfit: takeProfit

    };

    const result = await connection.createMarketOrder(order);

    const parsed = parseOrderResponse(result);

    if (parsed?.ticket) {
      registerRecentTicket(parsed.ticket);
    }

    console.log(
      `[ORDER] LEG${leg} ${side} ${volume} placed`,
      parsed?.ticket
    );

    return parsed;

  } catch (err) {

    console.error('[ORDER] Placement failed:', err.message || err);
    throw err;

  }
}

module.exports = {
  safePlaceMarketOrder,
  parseOrderResponse,
  setBrokerConnection
};