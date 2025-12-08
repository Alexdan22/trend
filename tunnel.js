const express = require("express");
const axios = require("axios");

const app = express();

/* --------------------------------------------------
   SAFE JSON PARSER (prevents iconv-lite/raw-body crash)
----------------------------------------------------- */
app.use(express.json({
  strict: false,        // allow non-standard JSON without crashing
  limit: "1mb"          // prevents large payload attacks
}));

// Global JSON parse error handler
app.use((err, req, res, next) => {
  console.log("❌ Body parser error:", err?.message);
  return res.status(400).json({ ok: false, error: "Invalid JSON payload" });
});

/* --------------------------------------------------
   BOT TARGETS
----------------------------------------------------- */
const bots = [
  "http://localhost:5001/webhook",
  "http://localhost:5002/webhook"
];

/* --------------------------------------------------
   FORWARD FUNCTION with retry + timeout
----------------------------------------------------- */
async function forward(url, payload) {
  try {
    await axios.post(url, payload, { timeout: 2000 });
    console.log(`✔ Delivered → ${url}`);
  } catch (err) {
    console.log(`⚠ First attempt failed → ${url}: ${err.message}`);

    try {
      await axios.post(url, payload);
      console.log(`✔ Delivered on retry → ${url}`);
    } catch (err2) {
      console.log(`❌ FINAL FAILURE → ${url}: ${err2.message}`);
    }
  }
}

/* --------------------------------------------------
   MAIN WEBHOOK (TradingView hits this)
----------------------------------------------------- */
app.post("/webhook", (req, res) => {
  const payload = req.body || {};

  bots.forEach(url => forward(url, payload));

  return res.json({ ok: true });
});

/* --------------------------------------------------
   BLOCK ALL OTHER ROUTES (protect against scanners)
----------------------------------------------------- */
app.all("*", (req, res) => {
  console.log(`⚠ Blocked unknown request: ${req.method} ${req.url}`);
  return res.status(404).send("Not allowed");
});

/* --------------------------------------------------
   START SERVER ON PORT 80
----------------------------------------------------- */
app.listen(3000, () => {
  console.log("🚀 Tunnel running on port 3000");
});
