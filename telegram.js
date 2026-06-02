const TelegramBot = require("node-telegram-bot-api");
const { 
  // accounts
  listAccounts,
  listAvailableAccounts,
  setAccountEnabled,
  setAccountPaused,
  setLotSize,
  pauseAccountsByUser,
  assignAccountToUser,
  unassignAccount,

  // users
  getTelegramUser,
  getUserByUserId,
  getAccountById,
  listUsers,
  listUsersWithoutAccounts,
  getAccountsGroupedByUser,
  getTelegramUsersMap,

  // onboarding
  addPendingUser,
  listPendingUsers,
  removePendingUser,
  createUserFromPending,
  getAccountsByUser
} = require("./models");
const { buildTradeReport } = require("./services/reporting/reportBuilder");


const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");

const { connectDB } = require("./db");

let bot = null;
let commandHandlersRegistered = false;

const TELEGRAM_COMMAND_RETRY_LIMIT = Number(
  process.env.TELEGRAM_RETRY_LIMIT || 4,
);
const TELEGRAM_COMMAND_RETRY_BASE_MS = Number(
  process.env.TELEGRAM_RETRY_BASE_MS || 1200,
);
const TELEGRAM_COMMAND_RETRY_MAX_MS = Number(
  process.env.TELEGRAM_RETRY_MAX_MS || 12000,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeTelegramError(error, depth = 0) {
  if (!error || depth > 2) return "";

  const parts = [];
  if (error.code) parts.push(`code=${error.code}`);
  if (error.response?.statusCode) {
    parts.push(`status=${error.response.statusCode}`);
  }
  if (error.message) parts.push(`message=${error.message}`);

  if (Array.isArray(error.errors) && error.errors.length) {
    const nested = error.errors
      .slice(0, 3)
      .map((item) => summarizeTelegramError(item, depth + 1))
      .filter(Boolean)
      .join(" | ");
    if (nested) parts.push(`nested=[${nested}]`);
  }

  if (error.cause) {
    const cause = summarizeTelegramError(error.cause, depth + 1);
    if (cause) parts.push(`cause=[${cause}]`);
  }

  return parts.join(" ");
}

function telegramRetryDelay(attempt) {
  const base =
    TELEGRAM_COMMAND_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * 350);
  return Math.min(TELEGRAM_COMMAND_RETRY_MAX_MS, base + jitter);
}

function isPermanentTelegramError(error) {
  const status = Number(error?.response?.statusCode);
  return [400, 401, 403].includes(status);
}

async function withTelegramRetry(label, operation) {
  let lastError = null;

  for (let attempt = 1; attempt <= TELEGRAM_COMMAND_RETRY_LIMIT; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const summary = summarizeTelegramError(error) || String(error);

      if (
        isPermanentTelegramError(error) ||
        attempt === TELEGRAM_COMMAND_RETRY_LIMIT
      ) {
        console.warn(
          `[TELEGRAM ${label}] failed after ${attempt}/${TELEGRAM_COMMAND_RETRY_LIMIT}: ${summary}`,
        );
        break;
      }

      const waitMs = telegramRetryDelay(attempt);
      console.warn(
        `[TELEGRAM ${label}] attempt ${attempt}/${TELEGRAM_COMMAND_RETRY_LIMIT} failed, retrying in ${waitMs}ms: ${summary}`,
      );
      await sleep(waitMs);
    }
  }

  throw lastError;
}

function installTelegramSendFailsafe(botInstance) {
  const sendMessage = botInstance.sendMessage.bind(botInstance);

  botInstance.__rawSendMessage = sendMessage;
  botInstance.sendMessage = (...args) =>
    withTelegramRetry("COMMAND_MESSAGE", () => sendMessage(...args));
}

function installTelegramDiagnostics(botInstance) {
  botInstance.on("polling_error", (error) => {
    const summary = summarizeTelegramError(error) || String(error);
    console.warn(`[TELEGRAM POLLING] ${summary}`);
  });

  botInstance.on("webhook_error", (error) => {
    const summary = summarizeTelegramError(error) || String(error);
    console.warn(`[TELEGRAM WEBHOOK] ${summary}`);
  });

  botInstance.on("error", (error) => {
    const summary = summarizeTelegramError(error) || String(error);
    console.warn(`[TELEGRAM ERROR] ${summary}`);
  });
}

function normalizeTelegramCommand(rawCommand) {
  return String(rawCommand || "")
    .split("@")[0]
    .toLowerCase();
}




const COMMANDS = {
  USER: [
    { cmd: "/register", desc: "Request access to the bot" },
    { cmd: "/my_account", desc: "View your assigned trading account" },
    { cmd: "/status", desc: "View trading status for this bot" },
    { cmd: "/pause", desc: "Pause new trade entries" },
    { cmd: "/resume", desc: "Resume new trade entries" }
  ],

  ADMIN: [
    { cmd: "/status", desc: "View trading account status" },
    { cmd: "/pause", desc: "Pause trading for the account" },
    { cmd: "/resume", desc: "Resume trading for the account" },
    { cmd: "/report_daily", desc: "Send today's strategy report" },
    { cmd: "/report_weekly", desc: "Send this week's strategy report" },
    { cmd: "/report_monthly", desc: "Send this month's strategy report" },

    { cmd: "/pending_users", desc: "List users awaiting approval" },
    { cmd: "/approve_user <telegramId>", desc: "Approve a pending user" },
    { cmd: "/reject_user <telegramId>", desc: "Reject a pending user" },

    { cmd: "/unassigned_users", desc: "List approved users without trading accounts" },
    { cmd: "/available_accounts", desc: "List deployed but unassigned trading accounts" },

    { cmd: "/assign_account <telegramId> <accountId>", desc: "Assign trading account to user" },
    { cmd: "/unassign_account <accountId>", desc: "Unassign account and disable trading safely" }
  ]
};



/* ---------- RBAC GUARD ---------- */

function requireRole(tgUser, allowedRoles) {
  if (!tgUser || !allowedRoles.includes(tgUser.role)) {
    throw new Error("Unauthorized command");
  }
}

/* ---------- HELPERS ---------- */

async function resolveContext(telegramId) {
  const tgUser = await getTelegramUser(telegramId);
  if (!tgUser) return null;

  const user = await getUserByUserId(tgUser.userId);
  if (!user) return null;

  return { tgUser, user };
}

function renderHelp(role) {
  const cmds =
    role === "ADMIN"
      ? [...COMMANDS.ADMIN]
      : [...COMMANDS.USER];

  let text = "Available commands:\n\n";

  for (const c of cmds) {
    text += `${c.cmd} — ${c.desc}\n`;
  }

  return text;
}

const OWNER_COMMANDS = [
  { cmd: "/status", desc: "View the live account state" },
  { cmd: "/pause", desc: "Pause new trade entries" },
  { cmd: "/resume", desc: "Resume new trade entries" },
  { cmd: "/report_daily", desc: "Send today's report to the group" },
  { cmd: "/report_weekly", desc: "Send this week's report to the group" },
  { cmd: "/report_monthly", desc: "Send this month's report to the group" },
  { cmd: "/help", desc: "Show this command list" },
];

let ownerWarningLogged = false;

function parseTelegramIdList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function commandOwnerIds() {
  return parseTelegramIdList(
    process.env.TELEGRAM_OWNER_IDS ||
      process.env.TELEGRAM_COMMAND_USER_IDS ||
      process.env.TELEGRAM_ALLOWED_USER_IDS,
  );
}

function isAuthorizedCommandUser(telegramId) {
  const owners = commandOwnerIds();

  if (!owners.length) {
    if (!ownerWarningLogged) {
      console.warn("[TELEGRAM] No command owner IDs configured; allowing commands");
      ownerWarningLogged = true;
    }

    return true;
  }

  return owners.includes(String(telegramId));
}

function reportChatId() {
  return process.env.TELEGRAM_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
}

function renderOwnerHelp() {
  let text = "Available commands:\n\n";

  for (const c of OWNER_COMMANDS) {
    text += `${c.cmd} - ${c.desc}\n`;
  }

  return text;
}

async function getSingleAccount() {
  const accountId = process.env.METAAPI_ACCOUNT_ID;
  if (!accountId) throw new Error("METAAPI_ACCOUNT_ID missing");

  const account = await getAccountById(accountId);
  return { accountId, account };
}

function renderSingleAccountStatus(accountId, account) {
  const paused = account?.userPaused === true;
  const state = account?.status || "DEPLOYED";

  return (
    "ACCOUNT STATUS\n\n" +
    `Account ID:\n${accountId}\n\n` +
    `New Entries: ${paused ? "PAUSED" : "ACTIVE"}\n` +
    `State: ${state}\n\n` +
    `Reports: ${reportChatId() ? "Group configured" : "Group not configured"}`
  );
}

async function sendLongMessage(bot, chatId, text, limit = 3900) {
  if (text.length <= limit) {
    return bot.sendMessage(chatId, text);
  }

  let remaining = text;

  while (remaining.length > limit) {
    const index = remaining.lastIndexOf("\n", limit);
    const splitAt = index > 1000 ? index : limit;
    await bot.sendMessage(chatId, remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    await bot.sendMessage(chatId, remaining);
  }
}

async function sendManualReport(bot, chatId, period) {
  const targetChatId = reportChatId();
  if (!targetChatId) throw new Error("TELEGRAM_REPORT_CHAT_ID or TELEGRAM_CHAT_ID missing");

  const { message } = await buildTradeReport(period);
  await sendLongMessage(bot, targetChatId, message);

  if (String(targetChatId) !== String(chatId)) {
    return bot.sendMessage(chatId, `${period} report sent to the group.`);
  }

  return null;
}

async function handleOwnerCommand(bot, chatId, telegramId, command) {
  if (!isAuthorizedCommandUser(telegramId)) {
    console.warn(`[TELEGRAM COMMAND] unauthorized user=${telegramId}`);
    return bot.sendMessage(chatId, "Unauthorized.");
  }

  switch (command) {
    case "/start":
    case "/help":
      return bot.sendMessage(chatId, renderOwnerHelp());

    case "/status": {
      const { accountId, account } = await getSingleAccount();
      return bot.sendMessage(
        chatId,
        renderSingleAccountStatus(accountId, account),
      );
    }

    case "/pause": {
      const { accountId } = await getSingleAccount();
      await setAccountPaused(accountId, true);
      return bot.sendMessage(
        chatId,
        "TRADING PAUSED\n\nNew trade entries are paused for the live account.",
      );
    }

    case "/resume": {
      const { accountId } = await getSingleAccount();
      await setAccountPaused(accountId, false);
      return bot.sendMessage(
        chatId,
        "TRADING RESUMED\n\nNew trade entries are active for the live account.",
      );
    }

    case "/report_daily":
      await bot.sendMessage(chatId, "Building daily report for the group...");
      return sendManualReport(bot, chatId, "daily");

    case "/report_weekly":
      await bot.sendMessage(chatId, "Building weekly report for the group...");
      return sendManualReport(bot, chatId, "weekly");

    case "/report_monthly":
      await bot.sendMessage(chatId, "Building monthly report for the group...");
      return sendManualReport(bot, chatId, "monthly");

    default:
      return bot.sendMessage(chatId, renderOwnerHelp());
  }
}

async function initTelegramBot(options = {}) {
  const { polling = true, commands = polling } = options;

  if (bot) {
    if (commands) registerCommandHandlers(bot);
    return bot;
  }

  await connectDB();
  console.log("[DB] MongoDB connected (Telegram)");

  bot = new TelegramBot(token, { polling });
  installTelegramSendFailsafe(bot);
  installTelegramDiagnostics(bot);
  console.log(
    polling
      ? "[TELEGRAM] Bot polling started"
      : "[TELEGRAM] Bot initialized for outbound messages",
  );

  if (commands) registerCommandHandlers(bot);

  return bot;
}

/* ---------- COMMAND HANDLER ---------- */

function registerCommandHandlers(bot) {
  if (commandHandlersRegistered) return;
  commandHandlersRegistered = true;

bot.on("message", async (msg) => {
  if (!msg.text || !msg.text.startsWith("/")) return;

  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  
  const parts = msg.text.trim().split(/\s+/);
  const command = normalizeTelegramCommand(parts[0]);
  const args = parts.slice(1);

  console.log(
    `[TELEGRAM COMMAND] ${command} from=${telegramId} chat=${chatId}`,
  );

  try {
    return await handleOwnerCommand(bot, chatId, telegramId, command);
  } catch (err) {
    console.warn(
      `[TELEGRAM COMMAND] ${command} failed: ${err.message || err}`,
    );
    return bot.sendMessage(chatId, err.message || "Command failed.");
  }

  // 🔓 Allow onboarding commands without RBAC
    if (command === "/start") {
        const exists = await getTelegramUser(telegramId);

        if (exists) {
            return bot.sendMessage(
                chatId,
                "ℹ️ Already Registered\n\nYou already have access to the bot."
            );
        }

        return bot.sendMessage(
            chatId,
            "👋 WELCOME\n\n" +
            "You are not registered yet.\n\n" +
            "📩 To request access, send:\n" +
            "/register"
        );
    }


    if (command === "/register") {
        const exists = await getTelegramUser(telegramId);
        if (exists) {
            return bot.sendMessage(
                chatId,
                "ℹ️ Already Registered\n\nYou already have access to the bot."
            );
        }

        await addPendingUser(telegramId, msg.from.username);

        return bot.sendMessage(
            chatId,
            "🕒 REGISTRATION REQUESTED\n\n" +
            "Your access request has been submitted successfully.\n\n" +
            "⏳ Please wait for an admin to approve your request."
        );
    }



  try {
    const ctx = await resolveContext(telegramId);
    if (!ctx) {
      return bot.sendMessage(chatId, "Access not registered.");
    }

    const { tgUser, user } = ctx;

    switch (command) {

        case "/pause": {
            requireRole(tgUser, ["USER", "ADMIN"]);

            await pauseAccountsByUser(user.userId, true);   // pause

            return bot.sendMessage(
                chatId,
                "⏸️ TRADING PAUSED\n\n" +
                "New trade entries have been paused for your account(s)."
            );
        }

        case "/resume": {
            requireRole(tgUser, ["USER", "ADMIN"]);

            await pauseAccountsByUser(user.userId, false);  // resume

            return bot.sendMessage(
                chatId,
                "▶️ TRADING RESUMED\n\n" +
                "New trade entries are now enabled."
            );
        }

        case "/accounts": {
            requireRole(tgUser, ["ADMIN"]);

            const accounts = await listAccounts();
            if (!accounts.length) {
                return bot.sendMessage(
                    chatId,
                    "ℹ️ NO ACCOUNTS FOUND\n\nThere are currently no trading accounts."
                );
            }

            let text = "📂 ALL ACCOUNTS\n\n";
            for (const acc of accounts) {
                text +=
                    `📊 Account ID:\n${acc.accountId}\n` +
                    `• Enabled: ${acc.enabled ? "✅ Yes" : "❌ No"}\n` +
                    `• Paused: ${acc.userPaused ? "⏸️ Yes" : "▶️ No"}\n` +
                    `• Lot Size: ${acc.fixedLot}\n\n`;
            }

            return bot.sendMessage(chatId, text);
        }


        case "/lot": {
            requireRole(tgUser, ["ADMIN"]);

            const [, accountId, lotStr] = msg.text.split(" ");
            const lot = Number(lotStr);

            if (!accountId || !lot || lot <= 0) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ INVALID USAGE\n\n" +
                    "Correct format:\n" +
                    "/lot <accountId> <value>"
                );
            }

            await setLotSize(accountId, lot);

            return bot.sendMessage(
                chatId,
                "⚙️ LOT SIZE UPDATED\n\n" +
                `📊 Account ID:\n${accountId}\n\n` +
                `New Lot Size:\n${lot}`
            );
        }

        case "/enable": {
            requireRole(tgUser, ["ADMIN"]);

            const [, accountId] = msg.text.split(" ");
            if (!accountId) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ INVALID USAGE\n\n" +
                    "Correct format:\n" +
                    "/enable <accountId>"
                );
            }

            await setAccountEnabled(accountId, true);

            return bot.sendMessage(
                chatId,
                "▶️ TRADING ENABLED\n\n" +
                `Trading has been enabled for:\n${accountId}`
            );
        }

        case "/disable": {
            requireRole(tgUser, ["ADMIN"]);

            const [, accountId] = msg.text.split(" ");
            if (!accountId) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ INVALID USAGE\n\n" +
                    "Correct format:\n" +
                    "/disable <accountId>"
                );
            }

            await setAccountEnabled(accountId, false);

            return bot.sendMessage(
                chatId,
                "⏸️ TRADING DISABLED\n\n" +
                `Trading has been disabled for:\n${accountId}`
            );
        }


        case "/status": {
            requireRole(tgUser, ["USER", "ADMIN"]);

            const accountId = process.env.METAAPI_ACCOUNT_ID;
            const account = await getAccountById(accountId);

            return bot.sendMessage(
                chatId,
                "📊 ACCOUNT STATUS\n\n" +
                `Account ID:\n${accountId}\n\n` +
                "Trading:\n" +
                `• Enabled: ${account.enabled ? "✅ Yes" : "❌ No"}\n` +
                `• Paused: ${account.userPaused ? "⏸️ Yes" : "▶️ No"}\n\n` +
                `State:\n${account.status}`
            );
        }

        case "/report_daily": {
            requireRole(tgUser, ["ADMIN"]);
            await bot.sendMessage(chatId, "Building daily strategy report...");
            return sendManualReport(bot, chatId, "daily");
        }

        case "/report_weekly": {
            requireRole(tgUser, ["ADMIN"]);
            await bot.sendMessage(chatId, "Building weekly strategy report...");
            return sendManualReport(bot, chatId, "weekly");
        }

        case "/report_monthly": {
            requireRole(tgUser, ["ADMIN"]);
            await bot.sendMessage(chatId, "Building monthly strategy report...");
            return sendManualReport(bot, chatId, "monthly");
        }

        case "/pending_users": {
            requireRole(tgUser, ["ADMIN"]);

            const pending = await listPendingUsers();
            if (!pending.length) {
                return bot.sendMessage(
                    chatId,
                    "ℹ️ NO PENDING USERS\n\nThere are no users awaiting approval."
                );
            }

            let text = "🕒 PENDING USERS\n\n";
            for (const u of pending) {
                text +=
                    `• Telegram ID: ${u.telegramId}\n` +
                    `  Username: ${u.username || "N/A"}\n\n`;
            }

            return bot.sendMessage(chatId, text);
        }

        case "/approve": {
            requireRole(tgUser, ["ADMIN"]);

            const [, tgId] = msg.text.split(" ");
            if (!tgId) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ INVALID USAGE\n\nUsage:\n/approve <telegramId>"
                );
            }

            const pendingUsers = await listPendingUsers();
            const pending = pendingUsers.find(u => u.telegramId === Number(tgId));

            if (!pending) {
                return bot.sendMessage(
                    chatId,
                    "❌ USER NOT FOUND\n\nNo pending user found with that Telegram ID."
                );
            }

            const userId = await createUserFromPending(pending);
            await removePendingUser(Number(tgId));

            return bot.sendMessage(
                chatId,
                "✅ USER APPROVED\n\n" +
                `Telegram ID:\n${tgId}\n\n` +
                `User ID:\n${userId}`
            );
        }

        case "/reject": {
            requireRole(tgUser, ["ADMIN"]);

            const [, tgId] = msg.text.split(" ");
            if (!tgId) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ INVALID USAGE\n\nUsage:\n/reject <telegramId>"
                );
            }

            await removePendingUser(Number(tgId));

            return bot.sendMessage(
                chatId,
                "❌ USER REJECTED\n\n" +
                `Telegram ID:\n${tgId}`
            );
        }

        case "/assign_account": {
            requireRole(tgUser, ["ADMIN"]);

            const [, tgId, accountId] = msg.text.split(" ");
            if (!tgId || !accountId) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ INVALID USAGE\n\nUsage:\n/assign_account <telegramId> <accountId>"
                );
            }

            await assignAccountToUser({
                telegramId: Number(tgId),
                accountId
            });

            return bot.sendMessage(
                chatId,
                "📌 ACCOUNT ASSIGNED\n\n" +
                `Telegram ID:\n${tgId}\n\n` +
                `Account ID:\n${accountId}\n\n` +
                "⚠️ Trading is DISABLED by default."
            );
        }

        case "/available_accounts": {
            const accounts = await listAvailableAccounts();

            if (!accounts.length) {
                return bot.sendMessage(
                    chatId,
                    "ℹ️ NO AVAILABLE ACCOUNTS\n\nAll accounts are currently assigned."
                );
            }

            let text = "📂 AVAILABLE ACCOUNTS\n\n";
            for (const a of accounts) {
                text +=
                    `📊 Account ID:\n${a.accountId}\n` +
                    `• Broker: ${a.broker}\n` +
                    `• Symbol: ${a.symbol}\n` +
                    `• Status: ${a.status || "DEPLOYED"}\n\n`;
            }

            return bot.sendMessage(chatId, text);
        }

        case "/unassign_account": {
            if (args.length < 1) {
                return bot.sendMessage(
                    chatId,
                    "⚠️ INVALID USAGE\n\nUsage:\n/unassign_account <accountId>"
                );
            }

            const accountId = args[0];
            await unassignAccount(accountId);

            return bot.sendMessage(
                chatId,
                "♻️ ACCOUNT UNASSIGNED\n\n" +
                `Account ID:\n${accountId}\n\n` +
                "Trading has been disabled and the account is reset."
            );
        }

        case "/unassigned_users": {
            const users = await listUsersWithoutAccounts();

            if (!users.length) {
                return bot.sendMessage(
                    chatId,
                    "✅ ALL USERS ASSIGNED\n\nEvery approved user has a trading account."
                );
            }

            let text = "👤 USERS WITHOUT ACCOUNTS\n\n";
            for (const u of users) {
                text += `• ${u.name} (User ID: ${u.userId})\n`;
            }

            return bot.sendMessage(chatId, text);
        }

        case "/my_account": {
            requireRole(tgUser, ["USER", "ADMIN"]);

            const accounts = await getAccountsByUser(user.userId);

            if (!accounts.length) {
                return bot.sendMessage(
                    chatId,
                    "ℹ️ NO ACCOUNT ASSIGNED\n\n" +
                    "You do not have a trading account yet.\nPlease contact the admin."
                );
            }

            let text = "📊 YOUR ACCOUNT DETAILS\n\n";

            for (const acc of accounts) {
                text +=
                    `Account ID:\n${acc.accountId}\n` +
                    `• Broker: ${acc.broker}\n` +
                    `• Symbol: ${acc.symbol}\n` +
                    `• Enabled: ${acc.enabled ? "✅ Yes" : "❌ No"}\n` +
                    `• Paused: ${acc.userPaused ? "⏸️ Yes" : "▶️ No"}\n\n`;
            }

            return bot.sendMessage(chatId, text);
        }

        case "/users": {
            requireRole(tgUser, ["ADMIN"]);

            const users = await listUsers();
            if (!users.length) {
                return bot.sendMessage(
                    chatId,
                    "ℹ️ NO USERS FOUND\n\nThere are no registered users."
                );
            }

            const accountsByUser = await getAccountsGroupedByUser();
            const telegramMap = await getTelegramUsersMap();

            let text = "👥 REGISTERED USERS\n\n";

            for (const u of users) {
                const accounts = accountsByUser.get(u.userId) || [];
                const tgId = telegramMap.get(u.userId) || "N/A";

                text +=
                    `User ID: ${u.userId}\n` +
                    `Telegram ID: ${tgId}\n` +
                    `Enabled: ${u.enabled ? "✅ Yes" : "❌ No"}\n`;

                if (!accounts.length) {
                    text += "Accounts: none\n\n";
                    continue;
                }

                text += "Accounts:\n";
                for (const acc of accounts) {
                    text +=
                        ` • ${acc.accountId} | ` +
                        `Enabled: ${acc.enabled ? "Yes" : "No"} | ` +
                        `Paused: ${acc.userPaused ? "Yes" : "No"}\n`;
                }

                text += "\n";
            }

            return bot.sendMessage(chatId, text);
        }




        default: {
            const helpText = renderHelp(tgUser.role);
            return bot.sendMessage(chatId, helpText);
        }

    }
  } catch (err) {
    console.warn(
      `[TELEGRAM COMMAND] ${command} failed: ${err.message || err}`,
    );
    return bot.sendMessage(chatId, err.message || "Command failed.");
  }
});
}

function getBot() {
  if (!bot) {
    throw new Error("Telegram bot not initialized. Call initTelegramBot() first.");
  }
  return bot;
}

module.exports = { initTelegramBot, getBot };

