const express = require("express");
const axios = require("axios");

const app = express();

/* SAFE JSON PARSER */
app.use(express.json({
  strict: false,
  limit: "1mb"
}));

app.use((err, req, res, next) => {
  console.log("❌ Body parser error:", err?.message);
  return res.status(400).json({ ok: false, error: "Invalid JSON payload" });
});

/* BOT TARGETS */
const bots = [
  "http://localhost:5001/webhook",
  "http://localhost:5002/webhook"
];

/* FORWARD FUNCTION — SINGLE ATTEMPT ONLY */
async function forward(url, payload) {
  try {
    await axios.post(url, payload, { timeout: 2000 });
    console.log(`✔ Delivered → ${url}`);
  } catch (err) {
    console.log(`❌ Delivery failed → ${url}: ${err.message}`);
  }
}

/* MAIN WEBHOOK */
app.post("/webhook", (req, res) => {
  const payload = req.body || {};
  bots.forEach(url => forward(url, payload));
  return res.json({ ok: true });
});

/* BLOCK EVERYTHING ELSE — Express 5 compatible */
app.use((req, res) => {
  console.log(`⚠ Blocked unknown request: ${req.method} ${req.url}`);
  res.status(404).send("Not allowed");
});

/* START SERVER */
app.listen(3000, () => {
  console.log("🚀 Tunnel running on port 3000");
});
