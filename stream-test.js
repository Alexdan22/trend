require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const MetaApi = require('metaapi.cloud-sdk').default;

const SYMBOL = process.env.SYMBOL || 'XAUUSDm';

// 🔥 State
let connection;
let lastTickTime = Date.now();
let lastPrice = null;
let tickCount = 0;

async function start() {
  try {
    console.log('[TEST] Starting clean stream test...\n');

    const api = new MetaApi(process.env.METAAPI_TOKEN);

    const account = await api.metatraderAccountApi.getAccount(
      process.env.METAAPI_ACCOUNT_ID
    );

    console.log('[TEST] Account:', account.id);
    console.log('[TEST] State:', account.state, account.connectionStatus);

    // Ensure deployed
    if (account.state !== 'DEPLOYED') {
      console.log('[TEST] Deploying account...');
      await account.deploy();
    }

    // Ensure connected
    if (account.connectionStatus !== 'CONNECTED') {
      console.log('[TEST] Waiting for broker connection...');
      await account.waitConnected();
    }

    console.log('[TEST] ✅ Broker connected');

    // Streaming connection
    connection = account.getStreamingConnection();

    console.log('[TEST] Connecting streaming...');
    await connection.connect();
    await connection.waitSynchronized();

    console.log('[TEST] ✅ Streaming synchronized');

    // Subscribe
    await connection.subscribeToMarketData(SYMBOL);
    console.log(`[TEST] Subscribed to ${SYMBOL}\n`);

    // 🔥 STREAM LISTENER (clean, no SDK errors)
    connection.addSynchronizationListener({
        onSymbolPriceUpdated: (instanceIndex, price) => {
            if (!price || price.symbol !== SYMBOL) return;

            const bid = price.bid;
            const now = Date.now();

            tickCount++;

            const changed = bid !== lastPrice;

            console.log(
            `[TICK] ${new Date().toLocaleTimeString()} | Bid: ${bid} | Changed: ${changed}`
            );

            lastPrice = bid;
            lastTickTime = now;
        },

        // 🔇 silence ALL MetaAPI internal events
        onSymbolPricesUpdated: () => {},
        onSymbolSpecificationUpdated: () => {},
        onSymbolSpecificationsUpdated: () => {},
        onBrokerConnectionStatusChanged: () => {},
        onHealthStatus: () => {},
        onDisconnected: () => {},
        onConnected: () => {},
        onAccountInformationUpdated: () => {}
    });

    // 🔥 HEALTH + STALE WATCHDOG
    setInterval(() => {
      const now = Date.now();
      const diff = now - lastTickTime;

      console.log(
        `[HEALTH] Last tick ${Math.floor(diff / 1000)}s ago | Total ticks: ${tickCount}`
      );

      if (diff > 20000) {
        console.error('[ALERT] 🚨 STALE STREAM DETECTED (>20s no ticks)');
      }
    }, 5000);

  } catch (err) {
    console.error('[TEST ERROR]', err.message || err);
  }
}

start();