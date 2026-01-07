const { getDB } = require("./db");

/* ---------------- USERS ---------------- */

async function getUserByUserId(userId) {
  return getDB().collection("users").findOne({ userId });
}

/* ---------------- TELEGRAM USERS ---------------- */

async function getTelegramUser(telegramId) {
  return getDB().collection("telegram_users").findOne({ telegramId });
}

/* ---------------- ACCOUNTS ---------------- */

async function getAccountById(accountId) {
  return getDB().collection("accounts").findOne({ accountId });
}

/* ---------------- PAIRS ---------------- */

async function savePair(pair) {
  return getDB().collection("pairs").updateOne(
    { pairId: pair.pairId },
    {
      $set: {
        ...pair,
        updatedAt: new Date()
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}


async function updatePair(pairId, update) {
  return getDB().collection("pairs").updateOne(
    { pairId },
    { $set: { ...update, updatedAt: new Date() } }
  );
}

async function finalizePairDB(pairId, reason) {
  return getDB().collection("pairs").updateOne(
    { pairId },
    {
      $set: {
        state: "CLOSED",
        closingReason: reason,
        closedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );
}

async function loadOpenPairs() {
  return getDB()
    .collection("pairs")
    .find({ state: { $ne: "CLOSED" } })
    .toArray();
}
//
async function listAccounts() {
  return getDB().collection("accounts").find({}).toArray();
}

async function setAccountEnabled(accountId, enabled) {
  return getDB().collection("accounts").updateOne(
    { accountId },
    { $set: { enabled, lastUpdatedAt: new Date() } }
  );
}

async function setLotSize(accountId, lot) {
  return getDB().collection("accounts").updateOne(
    { accountId },
    { $set: { fixedLot: lot, lastUpdatedAt: new Date() } }
  );
}

async function pauseAccountsByUser(userId, paused) {
  return getDB().collection("accounts").updateMany(
    { userId },
    { $set: { userPaused: paused, lastUpdatedAt: new Date() } }
  );
}

async function saveTrade(trade) {
  return getDB().collection("trades").updateOne(
    { tradeId: trade.tradeId },
    {
      $set: {
        ...trade,
        updatedAt: new Date()
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}


async function getTradesByUser(userId, from, to) {
  const query = {
    userId,
    closedAt: { $gte: from, $lte: to }
  };
  return getDB().collection("trades").find(query).toArray();
}

async function getTradesAll(from, to) {
  return getDB().collection("trades").find({
    closedAt: { $gte: from, $lte: to }
  }).toArray();
}


// ---------------- TELEGRAM USER MANAGEMENT ----------------

async function addPendingUser(telegramId, username) {
  return getDB().collection("pending_users").updateOne(
    { telegramId },
    {
      $setOnInsert: {
        telegramId,
        username,
        status: "PENDING",
        requestedAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function listPendingUsers() {
  return getDB().collection("pending_users").find({ status: "PENDING" }).toArray();
}

async function removePendingUser(telegramId) {
  return getDB().collection("pending_users").deleteOne({ telegramId });
}

async function createUserFromPending({ telegramId, username }) {
  const userId = `user-${telegramId}`;

  await getDB().collection("users").insertOne({
    userId,
    name: username || `user-${telegramId}`,
    enabled: true,
    createdAt: new Date()
  });

  await getDB().collection("telegram_users").insertOne({
    telegramId,
    role: "USER",
    userId,
    createdAt: new Date()
  });

  return userId;
}

/* ---------------- ACCOUNT ASSIGNMENT ---------------- */

async function assignAccountToUser({ telegramId, accountId, symbol, broker }) {
  const tgUser = await getDB()
    .collection("telegram_users")
    .findOne({ telegramId });

  if (!tgUser) throw new Error("Telegram user not found");

  const userId = tgUser.userId;

  return getDB().collection("accounts").updateOne(
    { accountId },
    {
      $setOnInsert: {
        accountId,
        userId,
        broker: broker || "EXNESS",
        symbol: symbol || "XAUUSDm",
        enabled: false,        // 🚨 disabled by default
        userPaused: true,      // 🚨 paused by default
        fixedLot: 0.01,
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function upsertDeployedAccount({
  accountId,
  broker = "EXNESS",
  symbol = "XAUUSDm"
}) {
  return getDB().collection("accounts").updateOne(
    { accountId },
    {
      $setOnInsert: {
        accountId,
        broker,
        symbol,

        telegramId: null,        // not assigned yet
        enabled: false,          // hard safety gate
        userPaused: true,        // paused by default

        status: "DEPLOYED",      // DEPLOYED | ASSIGNED | ACTIVE
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}


async function unassignAccount(accountId) {
  return getDB().collection("accounts").deleteOne({ accountId });
}

/* ---------------- USER ACCOUNT VISIBILITY ---------------- */

async function getAccountsByUser(userId) {
  return getDB()
    .collection("accounts")
    .find({ userId })
    .toArray();
}

/* ---------------- ADMIN USER OVERVIEW ---------------- */

async function listUsers() {
  return getDB().collection("users").find({}).toArray();
}

async function getAccountsGroupedByUser() {
  const accounts = await getDB().collection("accounts").find({}).toArray();
  const map = new Map();

  for (const acc of accounts) {
    if (!map.has(acc.userId)) map.set(acc.userId, []);
    map.get(acc.userId).push(acc);
  }

  return map;
}

async function getTelegramUsersMap() {
  const tgs = await getDB().collection("telegram_users").find({}).toArray();
  const map = new Map();
  for (const tg of tgs) {
    map.set(tg.userId, tg.telegramId);
  }
  return map;
}






module.exports = {
  getUserByUserId,
  addPendingUser,
  listPendingUsers,
  listUsers,
  getAccountsGroupedByUser,
  getTelegramUsersMap,
  getAccountsByUser,
  removePendingUser,
  createUserFromPending,
  assignAccountToUser,
  upsertDeployedAccount,
  unassignAccount,
  saveTrade,
  getTradesByUser,
  getTelegramUser,
  getTradesAll,
  getAccountById,
  savePair,
  updatePair,
  finalizePairDB,
  loadOpenPairs,
  listAccounts,
  setAccountEnabled,
  setLotSize,
  pauseAccountsByUser
};
