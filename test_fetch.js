require('dotenv').config();

(async () => {
  const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
  const key = process.env.TWELVE_DATA_KEY;
  if (!key) {
    console.error("❌  No TWELVE_DATA_KEY found in .env");
    process.exit(1);
  }
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=5min&outputsize=5&apikey=${key}`;
  console.log("🔗  Fetching:", url);
  const r = await fetch(url);
  const j = await r.json();
  console.log("✅  Response:");
  console.dir(j, { depth: null });
})();
