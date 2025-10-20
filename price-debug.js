// price-debug.js
const MetaApi = require('metaapi.cloud-sdk').default;

const METAAPI_TOKEN =  "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2ODJjYjY5YmQ2ZWQxYWZiN2M2NWE2MzA4NGQ3NzZiOCIsImFjY2Vzc1J1bGVzIjpbeyJpZCI6InRyYWRpbmctYWNjb3VudC1tYW5hZ2VtZW50LWFwaSIsIm1ldGhvZHMiOlsidHJhZGluZy1hY2NvdW50LW1hbmFnZW1lbnQtYXBpOnJlc3Q6cHVibGljOio6KiJdLCJyb2xlcyI6WyJyZWFkZXIiLCJ3cml0ZXIiXSwicmVzb3VyY2VzIjpbIio6JFVTRVJfSUQkOjEyOGUzNTczLWM5M2QtNDBkZS1iNjdiLTg2MzRlMTg2M2NlMyJdfSx7ImlkIjoibWV0YWFwaS1yZXN0LWFwaSIsIm1ldGhvZHMiOlsibWV0YWFwaS1hcGk6cmVzdDpwdWJsaWM6KjoqIl0sInJvbGVzIjpbInJlYWRlciIsIndyaXRlciJdLCJyZXNvdXJjZXMiOlsiYWNjb3VudDokVVNFUl9JRCQ6MTI4ZTM1NzMtYzkzZC00MGRlLWI2N2ItODYzNGUxODYzY2UzIl19LHsiaWQiOiJtZXRhYXBpLXJwYy1hcGkiLCJtZXRob2RzIjpbIm1ldGFhcGktYXBpOndzOnB1YmxpYzoqOioiXSwicm9sZXMiOlsicmVhZGVyIiwid3JpdGVyIl0sInJlc291cmNlcyI6WyJhY2NvdW50OiRVU0VSX0lEJDoxMjhlMzU3My1jOTNkLTQwZGUtYjY3Yi04NjM0ZTE4NjNjZTMiXX0seyJpZCI6Im1ldGFhcGktcmVhbC10aW1lLXN0cmVhbWluZy1hcGkiLCJtZXRob2RzIjpbIm1ldGFhcGktYXBpOndzOnB1YmxpYzoqOioiXSwicm9sZXMiOlsicmVhZGVyIiwid3JpdGVyIl0sInJlc291cmNlcyI6WyJhY2NvdW50OiRVU0VSX0lEJDoxMjhlMzU3My1jOTNkLTQwZGUtYjY3Yi04NjM0ZTE4NjNjZTMiXX0seyJpZCI6Im1ldGFzdGF0cy1hcGkiLCJtZXRob2RzIjpbIm1ldGFzdGF0cy1hcGk6cmVzdDpwdWJsaWM6KjoqIl0sInJvbGVzIjpbInJlYWRlciIsIndyaXRlciJdLCJyZXNvdXJjZXMiOlsiYWNjb3VudDokVVNFUl9JRCQ6MTI4ZTM1NzMtYzkzZC00MGRlLWI2N2ItODYzNGUxODYzY2UzIl19LHsiaWQiOiJyaXNrLW1hbmFnZW1lbnQtYXBpIiwibWV0aG9kcyI6WyJyaXNrLW1hbmFnZW1lbnQtYXBpOnJlc3Q6cHVibGljOio6KiJdLCJyb2xlcyI6WyJyZWFkZXIiLCJ3cml0ZXIiXSwicmVzb3VyY2VzIjpbImFjY291bnQ6JFVTRVJfSUQkOjEyOGUzNTczLWM5M2QtNDBkZS1iNjdiLTg2MzRlMTg2M2NlMyJdfSx7ImlkIjoiY29weWZhY3RvcnktYXBpIiwibWV0aG9kcyI6WyJjb3B5ZmFjdG9yeS1hcGk6cmVzdDpwdWJsaWM6KjoqIl0sInJvbGVzIjpbInJlYWRlciIsIndyaXRlciJdLCJyZXNvdXJjZXMiOlsiKjokVVNFUl9JRCQ6KjEyOGUzNTczLWM5M2QtNDBkZS1iNjdiLTg2MzRlMTg2M2NlMyJdfSx7ImlkIjoibXQtbWFuYWdlci1hcGkiLCJtZXRob2RzIjpbIm10LW1hbmFnZXItYXBpOnJlc3Q6ZGVhbGluZzoqOioiLCJtdC1tYW5hZ2VyLWFwaTpyZXN0OnB1YmxpYzoqOioiXSwicm9sZXMiOlsicmVhZGVyIiwid3JpdGVyIl0sInJlc291cmNlcyI6WyIqOiRVU0VSX0lEJDoqMTI4ZTM1NzMtYzkzZC00MGRlLWI2N2ItODYzNGUxODYzY2UzIl19LHsiaWQiOiJiaWxsaW5nLWFwaSIsIm1ldGhvZHMiOlsiYmlsbGluZy1hcGk6cmVzdDpwdWJsaWM6KjoqIl0sInJvbGVzIjpbInJlYWRlciJdLCJyZXNvdXJjZXMiOlsiKjokVVNFUl9JRCQ6KjEyOGUzNTczLWM5M2QtNDBkZS1iNjdiLTg2MzRlMTg2M2NlMyJdfV0sImlnbm9yZVJhdGVMaW1pdHMiOmZhbHNlLCJ0b2tlbklkIjoiMjAyMTAyMTMiLCJpbXBlcnNvbmF0ZWQiOmZhbHNlLCJyZWFsVXNlcklkIjoiNjgyY2I2OWJkNmVkMWFmYjdjNjVhNjMwODRkNzc2YjgiLCJpYXQiOjE3NTkzMjQwMjMsImV4cCI6MTc2MTkxNjAyM30.DMjxRN-yfnyDnMuFdQs_Mt8aONO8VWqramptXGk1yrFtepp4dRxWAikEulWy-ki0hF9R8hy_qtirocdl2OMU1JmlHaiOLdaJQUXuZXPGQcORsnDjW7lewQVyF1AkjR7SJ565fdTlLdlbuX82JpC0rm_GhiObvGvsmGQC-5-amfc71YYKz1rCDYon5XT4OhImqVjKZRxvPT2cMJ--1tN4bOvXpRg_hO-qYlsd3z5hp2kNU2HjAjJSJvArz_977dJ351t0Cy0R2S8YfTh0NUSql1ErjiP78NVnPNJ1OGTn-cuOV2Y1b3h-Jil97foSCPWmmXxj3ZUlbyxe3eLpmX8ynbd9QbNYGlEEQcMv9a8qdw9JqUaysD2a6SnRm9JNwcW2c8dcM1FzGmXTb-DgCtra8WO3LyRoEaYOvt_Gf3AfXcU1Y9dJTq8EggUGmVRQHy4J9VJnEY4qcyNbzEYCQNgvrOvcAtdGUSLQ3LTCE8bJNy6edNSnZmvXJJbgbDAcel5BbJW42nxYSQmYLNW4xHBVdvgcAqUFfBMrkBx2CuE0gZ9paOj82x3w3HFN7LLyp30_2WmUtIQFgJKTgTHgGNS49VA8QY-5UK9Qa_ZUzi7uEDNMGxU0V633DA8O7ndavClGDb7PaKzODeKlb22qdm7S7km9pAwQV19pns3-daSrnMw";
const ACCOUNT_ID = "128e3573-c93d-40de-b67b-8634e1863ce3";
const SYMBOL = process.env.SYMBOL || 'XAUUSDm';

(async () => {
  try {
    console.log(`[DEBUG] Connecting to account ${ACCOUNT_ID} ...`);
    const api = new MetaApi(METAAPI_TOKEN);
    const account = await api.metatraderAccountApi.getAccount(ACCOUNT_ID);

    if (account.state !== 'DEPLOYED') {
      console.log('[DEBUG] Deploying account...');
      await account.deploy();
    }

    if (account.connectionStatus !== 'CONNECTED') {
      console.log('[DEBUG] Waiting for broker connection...');
      await account.waitConnected();
    }

    const connection = account.getStreamingConnection();
    console.log('[DEBUG] Connecting streaming connection...');
    await connection.connect();

    console.log('[DEBUG] Waiting for synchronization...');
    await connection.waitSynchronized();
    console.log('[DEBUG] ✅ Connection synchronized.');

    console.log(`[DEBUG] Subscribing to ${SYMBOL} market data...`);
    await connection.subscribeToMarketData(SYMBOL);

    console.log('[DEBUG] Starting price monitor...\n');

    setInterval(() => {
      try {
        const p = connection?.terminalState?.price(SYMBOL);
        if (!p) {
          console.log('[DEBUG] ❌ No price yet for', SYMBOL);
        } else {
          console.log(`[DEBUG] ${SYMBOL} -> Bid: ${p.bid}, Ask: ${p.ask}`);
        }
      } catch (err) {
        console.log('[DEBUG] Error reading price:', err.message);
      }
    }, 1000);
  } catch (err) {
    console.error('[DEBUG] Connection error:', err.message);
  }
})();
