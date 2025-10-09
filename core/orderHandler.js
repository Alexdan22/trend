// core/orderHandler.js
// Robust order execution helpers - CommonJS

const accountModule = require('./account');
const utils = require('./utils');

const DEFAULT_SYMBOL = process.env.SYMBOL || 'XAUUSDm';

/**
 * Attempts to place a market order (BUY/SELL) using multiple API variants.
 * Returns the result object from the underlying API call (shape may vary by provider).
 */
async function safePlaceMarketOrder(action = 'BUY', volume = 0.01, stopLoss = null, takeProfit = null, symbol = DEFAULT_SYMBOL) {
  const connection = accountModule.getConnection();
  if (!connection) throw new Error('No connection (call connectMetaApi first)');

  // Normalize
  const typeLower = (action || '').toLowerCase();

  // Try several variations commonly found in MetaApi-like libs
  try {
    if (action === 'BUY' && typeof connection.createMarketBuyOrder === 'function') {
      return await connection.createMarketBuyOrder(symbol, volume, { stopLoss, takeProfit });
    }
    if (action === 'SELL' && typeof connection.createMarketSellOrder === 'function') {
      return await connection.createMarketSellOrder(symbol, volume, { stopLoss, takeProfit });
    }
  } catch (e) {
    utils.safeLog('[orderHandler] createMarketBuy/Sell failed:', e.message || e);
  }

  try {
    if (typeof connection.createMarketOrder === 'function') {
      // generic object shape
      return await connection.createMarketOrder({
        symbol,
        type: action === 'BUY' ? 'buy' : 'sell',
        volume,
        stopLoss,
        takeProfit
      });
    }
  } catch (e) {
    utils.safeLog('[orderHandler] createMarketOrder failed:', e.message || e);
  }

  try {
    if (typeof connection.sendOrder === 'function') {
      return await connection.sendOrder({
        symbol,
        type: action === 'BUY' ? 'buy' : 'sell',
        volume,
        stopLoss,
        takeProfit
      });
    }
  } catch (e) {
    utils.safeLog('[orderHandler] sendOrder failed:', e.message || e);
  }

  // Some accounts expose methods on account object
  try {
    const account = accountModule.getAccount();
    if (account && typeof account.createMarketBuyOrder === 'function' && action === 'BUY') {
      return await account.createMarketBuyOrder(symbol, volume, { stopLoss, takeProfit });
    }
    if (account && typeof account.createMarketSellOrder === 'function' && action === 'SELL') {
      return await account.createMarketSellOrder(symbol, volume, { stopLoss, takeProfit });
    }
  } catch (e) {
    utils.safeLog('[orderHandler] account.createMarketX failed:', e.message || e);
  }

  throw new Error('No supported market order method found on connection/account');
}

/**
 * Attempts to modify a position's parameters (e.g., stopLoss/takeProfit).
 * Params object: { stopLoss: <price>, takeProfit: <price>, ... }
 */
async function safeModifyPosition(positionId, params = {}) {
  try {
    const connection = accountModule.getConnection();
    if (connection && typeof connection.modifyPosition === 'function') {
      return await connection.modifyPosition(positionId, params);
    }
  } catch (e) {
    utils.safeLog('[orderHandler] modifyPosition failed:', e.message || e);
  }

  try {
    const connection = accountModule.getConnection();
    if (connection && typeof connection.modifyPositionByTicket === 'function') {
      return await connection.modifyPositionByTicket(positionId, params);
    }
  } catch (e) {
    utils.safeLog('[orderHandler] modifyPositionByTicket failed:', e.message || e);
  }

  try {
    const account = accountModule.getAccount();
    if (account && typeof account.modifyPosition === 'function') {
      return await account.modifyPosition(positionId, params);
    }
  } catch (e) {
    utils.safeLog('[orderHandler] account.modifyPosition failed:', e.message || e);
  }

  throw new Error('No supported modifyPosition API found');
}

/**
 * Attempts to close a position (full or partial). Returns an object:
 * { ok: true, res } on success
 * { ok: true, alreadyClosed: true } if already closed / not found
 * { ok: false, error } on unrecoverable error
 */
async function safeClosePosition(positionId, volume = null) {
  try {
    const connection = accountModule.getConnection();

    // variant: connection.closePosition(positionId, volume)
    if (connection && typeof connection.closePosition === 'function') {
      if (volume != null) {
        const res = await connection.closePosition(positionId, volume);
        return { ok: true, res };
      } else {
        const res = await connection.closePosition(positionId);
        return { ok: true, res };
      }
    }
  } catch (e) {
    const msg = (e && (e.message || '')).toString();
    if (/position not found/i.test(msg) || /not found/i.test(msg) || /Invalid ticket/i.test(msg)) {
      return { ok: true, res: null, alreadyClosed: true };
    }
    utils.safeLog('[orderHandler] closePosition failed:', e.message || e);
    return { ok: false, error: e };
  }

  try {
    const connection = accountModule.getConnection();
    if (connection && typeof connection.closePositionByTicket === 'function') {
      const res = await connection.closePositionByTicket(positionId, volume);
      return { ok: true, res };
    }
  } catch (e) {
    const msg = (e && (e.message || '')).toString();
    if (/not found/i.test(msg)) return { ok: true, alreadyClosed: true };
    return { ok: false, error: e };
  }

  try {
    const account = accountModule.getAccount();
    if (account && typeof account.closePosition === 'function') {
      const res = await account.closePosition(positionId, volume);
      return { ok: true, res };
    }
  } catch (e) {
    const msg = (e && (e.message || '')).toString();
    if (/not found/i.test(msg)) return { ok: true, alreadyClosed: true };
    return { ok: false, error: e };
  }

  return { ok: false, error: new Error('No closePosition API available on connection/account') };
}

/**
 * Attempts to fetch open positions using multiple fallbacks.
 * Returns an array (possibly empty).
 */
async function safeGetPositions() {
  try {
    const account = accountModule.getAccount();
    if (account && typeof account.getPositions === 'function') {
      const p = await account.getPositions();
      if (Array.isArray(p)) return p;
    }
  } catch (e) {
    utils.safeLog('[orderHandler] account.getPositions failed:', e.message || e);
  }

  try {
    const connection = accountModule.getConnection();
    if (connection?.terminalState?.positions) {
      const p = connection.terminalState.positions;
      if (Array.isArray(p)) return p;
    }
  } catch (e) {}

  try {
    const connection = accountModule.getConnection();
    if (connection && typeof connection.getOpenPositions === 'function') {
      const p = await connection.getOpenPositions();
      if (Array.isArray(p)) return p;
    }
  } catch (e) {
    utils.safeLog('[orderHandler] connection.getOpenPositions failed:', e.message || e);
  }

  return [];
}

module.exports = {
  safePlaceMarketOrder,
  safeModifyPosition,
  safeClosePosition,
  safeGetPositions
};
