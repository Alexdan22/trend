// testHistoricalRest.js (ESM version)
import 'dotenv/config';
import fetch from 'node-fetch';
import https from 'https';

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const symbol = 'XAUUSDm';
const timeframe = '1m';
const limit = 50;
const endTime = new Date().toISOString(); // current time

const url = `https://api.metaapi.cloud/users/current/accounts/${accountId}/historical-market-data/symbols/${symbol}/timeframes/${timeframe}/candles?endTime=${endTime}&limit=${limit}`;

const agent = new https.Agent({ rejectUnauthorized: false }); // Temporary SSL bypass

console.log('Fetching candles via REST...');

try {
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    agent
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const candles = await res.json();
  console.log(`✅ Received ${candles.length} candles`);
  console.log(candles.slice(-5));
} catch (err) {
  console.error('❌ REST request failed:');
  console.error(err);
}
