const { generateTradeChart } = require("./chartGenerator");

async function captureTradeSnapshot({
  event,
  rec,
  candles,
  exitPrice = null,
  exitTime = Date.now(),
}) {
  const buffer = await generateTradeChart({
    candles,
    side: rec.side,
    event,
    pairId: rec.pairId,
    entryPrice: rec.entryPrice,
    stopLoss: rec.internalSL ?? rec.sl,
    takeProfit: rec.tp,
    exitPrice,
    entryTime: rec.entryTimestamp || rec.openedAt,
    exitTime,
  });

  let caption = "";

  switch (event) {
    case "ENTRY":
      caption =
        `${rec.side === "BUY" ? "🟢" : "🔴"} ${event}\n` +
        `Pair: ${rec.pairId}\n` +
        `Entry: ${rec.entryPrice?.toFixed(2)}\n` +
        `TP: ${rec.tp?.toFixed(2)}\n` +
        `SL: ${(rec.internalSL ?? rec.sl)?.toFixed(2)}`;
      break;

    case "PARTIAL":
      caption =
        `🟠 PARTIAL CLOSED\n\n` +
        `Pair: ${rec.pairId}\n` +
        `Side: ${rec.side}\n\n` +
        `Entry: ${rec.entryPrice?.toFixed(2)}\n` +
        `Break-Even Activated`;
      break;

    case "TP":
      caption =
        `🎯 TAKE PROFIT HIT\n\n` +
        `Pair: ${rec.pairId}\n` +
        `Side: ${rec.side}\n\n` +
        `Entry: ${rec.entryPrice?.toFixed(2)}\n` +
        `TP: ${rec.tp?.toFixed(2)}`;
      break;

    case "BREAK_EVEN":
      caption =
        `🔵 BREAK-EVEN EXIT\n\n` +
        `Pair: ${rec.pairId}\n` +
        `Side: ${rec.side}\n\n` +
        `Entry: ${rec.entryPrice?.toFixed(2)}\n` +
        `Exit: ${rec.entryPrice?.toFixed(2)}`;
      break;

    case "STOP_LOSS":
      caption =
        `⛔ STOP LOSS HIT\n\n` +
        `Pair: ${rec.pairId}\n` +
        `Side: ${rec.side}\n\n` +
        `Entry: ${rec.entryPrice?.toFixed(2)}\n` +
        `SL: ${(rec.internalSL ?? rec.sl)?.toFixed(2)}`;
      break;
  }

  return {
    buffer,
    caption,
  };
}

module.exports = {
  captureTradeSnapshot,
};
