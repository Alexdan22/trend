require("dotenv").config();

const fs = require("fs");
const path = require("path");
const MetaApi = require("metaapi.cloud-sdk").default;

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));

  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];

  return fallback;
}

function numericArg(name, fallback) {
  const value = Number(getArg(name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

const SYMBOL = getArg("symbol", process.env.SYMBOL || "XAUUSDm");
const SAMPLE_SECONDS = numericArg("sample-seconds", 20);
const SAMPLE_INTERVAL_MS = numericArg("sample-interval-ms", 1000);
const HISTORY_DAYS = numericArg("history-days", 180);
const TICK_LIMIT = numericArg("tick-limit", 1000);
const SYNC_TIMEOUT_SECONDS = numericArg("sync-timeout", 60);
const HISTORY_PAGE_LIMIT = numericArg("history-page-limit", 1000);
const SKIP_TICKS = getArg("skip-ticks", "false") === "true";
const SKIP_HISTORY = getArg("skip-history", "false") === "true";
const REPORT_FILE = path.resolve(
  __dirname,
  getArg("output", path.join("artifacts", "backtests", "exness-cost-report.json")),
);

fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sortedValues[lower];

  return (
    sortedValues[lower] +
    (sortedValues[upper] - sortedValues[lower]) * (index - lower)
  );
}

function stats(values) {
  const clean = values
    .map(toNumber)
    .filter((value) => value != null)
    .sort((a, b) => a - b);

  if (!clean.length) {
    return {
      count: 0,
      min: null,
      mean: null,
      median: null,
      p75: null,
      p90: null,
      p95: null,
      max: null,
    };
  }

  const sum = clean.reduce((total, value) => total + value, 0);

  return {
    count: clean.length,
    min: clean[0],
    mean: sum / clean.length,
    median: percentile(clean, 0.5),
    p75: percentile(clean, 0.75),
    p90: percentile(clean, 0.9),
    p95: percentile(clean, 0.95),
    max: clean[clean.length - 1],
  };
}

function summarizeSpreads(samples, point) {
  const spreadsPrice = samples
    .map((sample) => sample.spreadPrice)
    .filter((value) => value != null);
  const spreadsPoints = point
    ? spreadsPrice.map((spread) => spread / point)
    : samples.map((sample) => sample.spreadPoints).filter((value) => value != null);

  return {
    priceUnits: stats(spreadsPrice),
    points: stats(spreadsPoints),
  };
}

function priceSpreadFromQuote(price, point) {
  const bid = toNumber(price?.bid);
  const ask = toNumber(price?.ask);
  const spreadField = toNumber(price?.spread);

  if (bid != null && ask != null) {
    const spreadPrice = ask - bid;
    return {
      time: price.time || price.brokerTime || new Date().toISOString(),
      bid,
      ask,
      spreadPrice,
      spreadPoints: point ? spreadPrice / point : spreadField,
      sourceSpreadPoints: spreadField,
    };
  }

  if (spreadField != null && point) {
    return {
      time: price?.time || price?.brokerTime || new Date().toISOString(),
      bid,
      ask,
      spreadPrice: spreadField * point,
      spreadPoints: spreadField,
      sourceSpreadPoints: spreadField,
    };
  }

  return null;
}

function derivePoint(specification) {
  const explicitPoint = toNumber(specification?.point);
  if (explicitPoint) return explicitPoint;

  const tickSize = toNumber(specification?.tickSize);
  if (tickSize) return tickSize;

  const digits = toNumber(specification?.digits);
  if (digits != null) return Math.pow(10, -digits);

  return null;
}

async function collectStreamingSpreadSamples(connection, symbol, point) {
  const samples = [];
  const deadline = Date.now() + SAMPLE_SECONDS * 1000;

  while (Date.now() <= deadline) {
    const price = connection.terminalState.price(symbol);
    const sample = priceSpreadFromQuote(price, point);

    if (sample) samples.push(sample);

    await sleep(SAMPLE_INTERVAL_MS);
  }

  return samples;
}

async function collectLiveSpreadSamples(connection, symbol, point) {
  const samples = [];
  const deadline = Date.now() + SAMPLE_SECONDS * 1000;

  while (Date.now() <= deadline) {
    try {
      const price = await connection.getSymbolPrice(symbol);
      const sample = priceSpreadFromQuote(price, point);

      if (sample) {
        samples.push(sample);
      }
    } catch (err) {
      samples.push({
        time: new Date().toISOString(),
        error: err.message || String(err),
      });
    }

    await sleep(SAMPLE_INTERVAL_MS);
  }

  return samples;
}

async function collectHistoricalTickSpreads(account, symbol, point) {
  try {
    const result = await account.getHistoricalTicks(
      symbol,
      undefined,
      0,
      TICK_LIMIT,
    );
    const ticks = Array.isArray(result) ? result : result?.ticks || [];

    return ticks
      .map((tick) => priceSpreadFromQuote(tick, point))
      .filter(Boolean);
  } catch (err) {
    return {
      error: err.message || String(err),
      samples: [],
    };
  }
}

async function fetchPagedHistory(connection, method, startTime, endTime) {
  const pageSize = 1000;
  const rows = [];

  for (let offset = 0; offset < HISTORY_PAGE_LIMIT; offset += pageSize) {
    const response = await connection[method](
      startTime,
      endTime,
      offset,
      pageSize,
    );
    const page =
      response?.historyOrders ||
      response?.deals ||
      (Array.isArray(response) ? response : []);

    rows.push(...page);

    if (page.length < pageSize) break;
  }

  return rows;
}

function orderSide(order) {
  const type = String(order?.type || "").toUpperCase();

  if (type.includes("BUY")) return "BUY";
  if (type.includes("SELL")) return "SELL";

  return null;
}

function dealSide(deal) {
  const type = String(deal?.type || "").toUpperCase();

  if (type.includes("BUY")) return "BUY";
  if (type.includes("SELL")) return "SELL";

  return null;
}

function entryType(deal) {
  return String(deal?.entryType || "").toUpperCase();
}

function isMarketOrder(order) {
  const type = String(order?.type || "").toUpperCase();
  return type === "ORDER_TYPE_BUY" || type === "ORDER_TYPE_SELL";
}

function estimateExecutionSlippage(orders, deals, symbol, point) {
  const symbolKey = symbol.toUpperCase();
  const symbolOrders = orders.filter(
    (order) =>
      String(order.symbol || "").toUpperCase() === symbolKey && isMarketOrder(order),
  );
  const symbolDeals = deals.filter(
    (deal) =>
      String(deal.symbol || "").toUpperCase() === symbolKey &&
      (entryType(deal).includes("IN") || entryType(deal).includes("OUT")) &&
      dealSide(deal),
  );
  const dealsByPosition = new Map();

  for (const deal of symbolDeals) {
    const key = String(deal.positionId || deal.orderId || deal.id || "");
    if (!key) continue;
    if (!dealsByPosition.has(key)) dealsByPosition.set(key, []);
    dealsByPosition.get(key).push(deal);
  }

  const samples = [];
  let skippedMissingRequestedPrice = 0;

  for (const order of symbolOrders) {
    const side = orderSide(order);
    const requested = toNumber(order.openPrice);
    const positionId = String(order.positionId || order.id || "");

    if (!side || requested == null || requested <= 0 || !positionId) {
      skippedMissingRequestedPrice += 1;
      continue;
    }

    const candidates = dealsByPosition.get(positionId) || [];
    const matchingDeal =
      candidates.find((deal) => dealSide(deal) === side) || candidates[0];

    const fill = toNumber(matchingDeal?.price);
    if (fill == null) continue;

    const signedPrice =
      side === "BUY" ? fill - requested : requested - fill;

    samples.push({
      time: matchingDeal.time || order.doneTime || order.time,
      side,
      requestedPrice: requested,
      fillPrice: fill,
      signedPrice,
      adversePrice: Math.max(0, signedPrice),
      absolutePrice: Math.abs(signedPrice),
      signedPoints: point ? signedPrice / point : null,
      adversePoints: point ? Math.max(0, signedPrice) / point : null,
      absolutePoints: point ? Math.abs(signedPrice) / point : null,
      orderId: String(order.id || ""),
      dealId: String(matchingDeal?.id || ""),
    });
  }

  return {
    ordersAnalyzed: symbolOrders.length,
    dealsAnalyzed: symbolDeals.length,
    matchedSamples: samples.length,
    skippedMissingRequestedPrice,
    adversePriceUnits: stats(samples.map((sample) => sample.adversePrice)),
    absolutePriceUnits: stats(samples.map((sample) => sample.absolutePrice)),
    signedPriceUnits: stats(samples.map((sample) => sample.signedPrice)),
    adversePoints: stats(samples.map((sample) => sample.adversePoints)),
    absolutePoints: stats(samples.map((sample) => sample.absolutePoints)),
    samples: samples.slice(-50),
    note:
      "Observed slippage is inferred from history order openPrice vs deal price. If market history orders store openPrice as 0 or as the executed price, requested-price data is unavailable and slippage cannot be reconstructed from history.",
  };
}

async function main() {
  if (!process.env.METAAPI_TOKEN || !process.env.METAAPI_ACCOUNT_ID) {
    throw new Error("METAAPI_TOKEN or METAAPI_ACCOUNT_ID is missing");
  }

  const api = new MetaApi(process.env.METAAPI_TOKEN);
  const account = await api.metatraderAccountApi.getAccount(
    process.env.METAAPI_ACCOUNT_ID,
  );
  const connection = account.getStreamingConnection();
  const startTime = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const endTime = new Date();

  await connection.connect();
  await connection.waitSynchronized({ timeoutInSeconds: SYNC_TIMEOUT_SECONDS });

  await connection.subscribeToMarketData(SYMBOL);

  await connection.terminalState.waitForPrice(SYMBOL, SYNC_TIMEOUT_SECONDS);

  const specification = connection.terminalState.specification(SYMBOL);
  const point = derivePoint(specification);
  const currentPrice = connection.terminalState.price(SYMBOL);
  const currentSpread = priceSpreadFromQuote(currentPrice, point);
  const liveSpreadSamples = await collectStreamingSpreadSamples(connection, SYMBOL, point);
  const historicalTickResult = SKIP_TICKS
    ? { skipped: true, samples: [] }
    : await collectHistoricalTickSpreads(account, SYMBOL, point);
  const historicalTickSamples = Array.isArray(historicalTickResult)
    ? historicalTickResult
    : historicalTickResult.samples || [];
  const historyOrders = SKIP_HISTORY
    ? []
    : connection.historyStorage.getHistoryOrdersByTimeRange(startTime, endTime);
  const deals = SKIP_HISTORY
    ? []
    : connection.historyStorage.getDealsByTimeRange(startTime, endTime);
  const executionSlippage = estimateExecutionSlippage(
    historyOrders,
    deals,
    SYMBOL,
    point,
  );
  const accountDefaultSlippagePoints = toNumber(account.slippage);

  try {
    await connection.unsubscribeFromMarketData(SYMBOL);
  } catch (_) {}

  try {
    await connection.close();
  } catch (_) {}

  const report = {
    generatedAt: new Date().toISOString(),
    account: {
      id: process.env.METAAPI_ACCOUNT_ID,
      name: account.name,
      type: account.type,
      state: account.state,
      connectionStatus: account.connectionStatus,
      defaultSlippagePoints: accountDefaultSlippagePoints,
      defaultSlippagePriceUnits:
        accountDefaultSlippagePoints != null && point
          ? accountDefaultSlippagePoints * point
          : null,
    },
    symbol: SYMBOL,
    specification: {
      digits: specification?.digits,
      point,
      tickSize: specification?.tickSize,
      contractSize: specification?.contractSize,
      execution: specification?.execution,
      tradeMode: specification?.tradeMode,
      stopsLevel: specification?.stopsLevel,
      freezeLevel: specification?.freezeLevel,
    },
    currentSpread,
    spread: {
      liveSamples: summarizeSpreads(liveSpreadSamples, point),
      historicalTicks: summarizeSpreads(historicalTickSamples, point),
      liveSampleSeconds: SAMPLE_SECONDS,
      liveSampleIntervalMs: SAMPLE_INTERVAL_MS,
      historicalTickLimit: TICK_LIMIT,
      historicalTicksSkipped: Boolean(historicalTickResult.skipped),
      historicalTickError: historicalTickResult.error || null,
      liveSamplesTail: liveSpreadSamples.filter((sample) => !sample.error).slice(-10),
    },
    executionSlippage,
    historyWindow: {
      start: startTime.toISOString(),
      end: endTime.toISOString(),
      days: HISTORY_DAYS,
      historyOrders: historyOrders.length,
      deals: deals.length,
      skipped: SKIP_HISTORY,
    },
    recommendedBacktestCost: {
      spreadPriceUnits:
        summarizeSpreads(
          historicalTickSamples.length ? historicalTickSamples : liveSpreadSamples,
          point,
        ).priceUnits.p75 ?? currentSpread?.spreadPrice ?? null,
      slippagePriceUnits:
        executionSlippage.adversePriceUnits.p75 ??
        (accountDefaultSlippagePoints != null && point
          ? accountDefaultSlippagePoints * point
          : 0),
      note:
        "Uses p75 spread and p75 adverse observed slippage when available. If observed slippage is unavailable, falls back to account default slippage allowance converted from points, then 0.",
    },
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify(
      {
        reportFile: REPORT_FILE,
        symbol: report.symbol,
        point: report.specification.point,
        currentSpread: report.currentSpread,
        liveSpreadPriceUnits: report.spread.liveSamples.priceUnits,
        historicalTickSpreadPriceUnits:
          report.spread.historicalTicks.priceUnits,
        accountDefaultSlippagePriceUnits:
          report.account.defaultSlippagePriceUnits,
        observedAdverseSlippagePriceUnits:
          report.executionSlippage.adversePriceUnits,
        recommendedBacktestCost: report.recommendedBacktestCost,
        historyWindow: report.historyWindow,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 500);
});
