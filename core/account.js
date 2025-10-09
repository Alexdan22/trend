// core/account.js
// Connection & account management (MetaApi) - CommonJS

const MetaApi = require('metaapi.cloud-sdk').default;
const MetaStats = require('metaapi.cloud-metastats-sdk').default;

let api = null;
let metastatsApi = null;
let account = null;
let connection = null;

const DEFAULT_TOKEN = process.env.METAAPI_TOKEN || '';
const DEFAULT_ACCOUNT_ID = process.env.METAAPI_ACCOUNT_ID || '';
const DEFAULT_SYMBOL = process.env.SYMBOL || 'XAUUSDm';

function ensureEnv(token = DEFAULT_TOKEN, accountId = DEFAULT_ACCOUNT_ID) {
  if (!token) throw new Error('METAAPI_TOKEN is required in env');
  if (!accountId) throw new Error('METAAPI_ACCOUNT_ID is required in env');
}

/**
 * Connect to MetaApi and return { api, account, connection, metastatsApi }
 * idempotent: if already connected, returns the existing objects.
 */
async function connectMetaApi({ token = DEFAULT_TOKEN, accountId = DEFAULT_ACCOUNT_ID } = {}) {
  ensureEnv(token, accountId);

  if (api && account && connection) {
    return { api, account, connection, metastatsApi };
  }

  api = new MetaApi(token);
  metastatsApi = new MetaStats(token);

  account = await api.metatraderAccountApi.getAccount(accountId);

  // deploy if necessary
  if (account.state !== 'DEPLOYED') {
    console.log('[account] deploying account...');
    await account.deploy();
    await account.waitConnected();
  }

  connection = account.getStreamingConnection();

  // connect and wait synchronized where available
  await connection.connect();
  if (typeof connection.waitSynchronized === 'function') {
    try {
      await connection.waitSynchronized();
    } catch (e) {
      // Some connections may not support this - continue
      console.warn('[account] waitSynchronized failed:', e.message || e);
    }
  }

  return { api, account, connection, metastatsApi };
}

function getConnection() {
  if (!connection) throw new Error('connectMetaApi must be called before getConnection()');
  return connection;
}

function getAccount() {
  if (!account) throw new Error('connectMetaApi must be called before getAccount()');
  return account;
}

/**
 * Attempts multiple fallbacks to retrieve a price for a symbol.
 * Returns { bid, ask, time } or null.
 */
async function getPrice(symbol = DEFAULT_SYMBOL) {
  try {
    if (!connection) throw new Error('No connection (call connectMetaApi first)');
    // terminalState.price may be a function returning {bid,ask}
    if (connection.terminalState && typeof connection.terminalState.price === 'function') {
      const p = connection.terminalState.price(symbol);
      if (p && p.bid != null && p.ask != null) return p;
    }
  } catch (e) {
    // swallow and continue
  }

  try {
    if (connection && typeof connection.getSymbolPrice === 'function') {
      const p = await connection.getSymbolPrice(symbol);
      if (p && p.bid != null && p.ask != null) return p;
    }
  } catch (e) {}

  try {
    if (account && typeof account.getSymbolPrice === 'function') {
      const p = await account.getSymbolPrice(symbol);
      if (p && p.bid != null && p.ask != null) return p;
    }
  } catch (e) {}

  return null;
}

/**
 * Attempts to fetch the account balance using multiple fallbacks (terminal state, account._data, metastats).
 * Returns numeric balance (or 0 if unavailable).
 */
async function getBalance() {
  try {
    if (connection?.terminalState?.accountInformation?.balance != null) {
      return connection.terminalState.accountInformation.balance;
    }
  } catch (e) {}

  try {
    if (account?._data?.balance != null) return account._data.balance;
  } catch (e) {}

  try {
    if (metastatsApi && typeof metastatsApi.getMetrics === 'function') {
      const metrics = await metastatsApi.getMetrics(account.id);
      if (metrics?.balance != null) return metrics.balance;
      if (metrics?.equity != null) return metrics.equity;
    }
  } catch (e) {}

  return 0;
}

/**
 * Subscribe to market data (if supported by the connection)
 */
async function subscribeToMarketData(symbol = DEFAULT_SYMBOL) {
  if (!connection) throw new Error('No connection (call connectMetaApi first)');
  if (typeof connection.subscribeToMarketData === 'function') {
    try {
      await connection.subscribeToMarketData(symbol);
      return true;
    } catch (e) {
      console.warn('[account] subscribeToMarketData error:', e.message || e);
      return false;
    }
  } else {
    console.warn('[account] subscribeToMarketData not supported by connection');
    return false;
  }
}

/**
 * Unsubscribe from market data for a symbol (when supported)
 */
async function unsubscribeFromMarketData(symbol = DEFAULT_SYMBOL) {
  if (!connection) return;
  if (typeof connection.unsubscribeFromMarketData === 'function') {
    try {
      await connection.unsubscribeFromMarketData(symbol);
      return true;
    } catch (e) {
      console.warn('[account] unsubscribeFromMarketData error:', e.message || e);
      return false;
    }
  }
  return false;
}

/**
 * Clean disconnect (attempts to close streaming connection)
 */
async function disconnect() {
  try {
    if (connection && typeof connection.disconnect === 'function') {
      await connection.disconnect();
    }
  } catch (e) {
    console.warn('[account] disconnect error:', e.message || e);
  }
  account = null;
  connection = null;
  api = null;
  metastatsApi = null;
}

module.exports = {
  connectMetaApi,
  getConnection,
  getAccount,
  getPrice,
  getBalance,
  subscribeToMarketData,
  unsubscribeFromMarketData,
  disconnect
};
