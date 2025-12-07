const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// Bot receivers
const bots = [
  "http://localhost:5001/webhook",
  "http://localhost:5002/webhook"
];

// ---- Safe Forward Function (Retry + Timeout) ----
async function forward(url, payload) {
  try {
    // First attempt with timeout (2 sec)
    await axios.post(url, payload, { timeout: 2000 });
    console.log(`✔ Delivered → ${url}`);
  } catch (err) {
    console.log(`⚠ First attempt failed → ${url}: ${err.message}`);

    // Retry once (no timeout limit)
    try {
      await axios.post(url, payload);
      console.log(`✔ Delivered on retry → ${url}`);
    } catch (err2) {
      console.log(`❌ FINAL FAILURE → ${url}: ${err2.message}`);
    }
  }
}

// ---- Main Webhook ----
app.post("/webhook", async (req, res) => {
  const payload = req.body;

  // Fan out to all bots
  bots.forEach(url => forward(url, payload));

  res.json({ ok: true });
});

// ---- Start Server ----
app.listen(3000, () => {
  console.log("Tunnel running on port 3000");
});
