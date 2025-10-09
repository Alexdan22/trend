// main.js
require('dotenv').config();
console.log = (...args) => {
  const time = new Date().toISOString();
  process.stdout.write(`[${time}] ` + args.join(' ') + '\n');
};

const { connectMetaApi, getConnection, subscribeToMarketData, disconnect } = require('./core/account');
const { handleTick } = require('./core/candleAggregator');

const SYMBOL = process.env.SYMBOL || 'XAUUSDm';

(async () => {
  try {
    console.log(`[INIT] Connecting to MetaApi...`);
    await connectMetaApi();
    const connection = getConnection();

    await subscribeToMarketData(SYMBOL);
    console.log(`✅ Subscribed to market data for ${SYMBOL}`);

    // 🩵 Add real-time tick listener (this shows you immediately when ticks start flowing)
    if (typeof connection.addTickListener === 'function') {
      connection.addTickListener(SYMBOL, tick => {
        console.log(`[LIVE TICK] ${SYMBOL} | Bid: ${tick.bid.toFixed(2)} | Ask: ${tick.ask.toFixed(2)}`);
        handleTick(tick);
      });
      console.log(`[LISTENER] Real-time tick listener attached for ${SYMBOL}`);
    } else {
      console.warn(`[WARN] connection.addTickListener not available, falling back to polling`);
    }

    // Fallback polling (still useful if addTickListener is unavailable)
    setInterval(() => {
      try {
        const price = connection?.terminalState?.price(SYMBOL);
        if (price && price.bid && price.ask) handleTick(price);
      } catch (e) {
        console.warn('[TICK] Poll failed:', e.message);
      }
    }, 2000);

    console.log('🤖 Trading bot running... waiting for first tick...');
  } catch (e) {
    console.error('❌ Error:', e.message);
  }
})();

process.on('SIGINT', async () => {
  console.log('🛑 Gracefully shutting down...');
  await disconnect();
  process.exit(0);
});
