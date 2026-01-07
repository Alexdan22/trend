const TelegramBot = require("node-telegram-bot-api");
const { 
  // accounts
  listAccounts,
  setAccountEnabled,
  setLotSize,
  pauseAccountsByUser,
  assignAccountToUser,
  unassignAccount,

  // users
  getTelegramUser,
  getUserByUserId,
  getAccountById,
  listUsers,
  getAccountsGroupedByUser,
  getTelegramUsersMap,

  // onboarding
  addPendingUser,
  listPendingUsers,
  removePendingUser,
  createUserFromPending,
  getAccountsByUser
} = require("./models");


const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");

const { connectDB } = require("./db");

let bot = null;




const COMMANDS = {
  USER: [
    { cmd: "/register", desc: "Request access to the bot" },
    { cmd: "/my_account", desc: "View your trading account status" },
    { cmd: "/status", desc: "View your account status" },
    { cmd: "/pause", desc: "Pause new trade entries" },
    { cmd: "/resume", desc: "Resume new trade entries" }
  ],
  ADMIN: [
    { cmd: "/status", desc: "View account status" },
    { cmd: "/pause", desc: "Pause trading (user or global)" },
    { cmd: "/resume", desc: "Resume trading" },
    { cmd: "/accounts", desc: "List all accounts" },
    { cmd: "/pending_users", desc: "List users awaiting approval" },
    { cmd: "/approve <telegramId>", desc: "Approve a pending user" },
    { cmd: "/reject <telegramId>", desc: "Reject a pending user" },
    { cmd: "/assign_account <telegramId> <accountId>", desc: "Assign trading account to user" },
    { cmd: "/unassign_account <accountId>", desc: "Remove trading account from user" },
    { cmd: "/lot <accountId> <value>", desc: "Change lot size for an account" },
    { cmd: "/enable", desc: "Enable trading for an account" },
    { cmd: "/disable", desc: "Disable trading for an account" }
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

async function initTelegramBot() {
  if (bot) return bot; // idempotent

  await connectDB();
  console.log("[DB] MongoDB connected (Telegram)");

  bot = new TelegramBot(token, { polling: true });
  console.log("📲 Telegram bot polling started");

  /* ---------- COMMAND HANDLER ---------- */

bot.on("message", async (msg) => {
  if (!msg.text || !msg.text.startsWith("/")) return;

  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const command = msg.text.split(" ")[0].toLowerCase();

  // 🔓 Allow onboarding commands without RBAC
    if (command === "/start") {
    const exists = await getTelegramUser(telegramId);

    if (exists) {
        return bot.sendMessage(chatId, "You are already registered.");
    }

    return bot.sendMessage(
        chatId,
        "Welcome.\nYou are not registered yet.\nSend /register to request access."
    );
    }

    if (command === "/register") {
    const exists = await getTelegramUser(telegramId);
    if (exists) {
        return bot.sendMessage(chatId, "You are already registered.");
    }

    await addPendingUser(telegramId, msg.from.username);

    return bot.sendMessage(
        chatId,
        "Registration request submitted.\nAwait admin approval."
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


        return bot.sendMessage(chatId, "Trading paused for your account(s).");
        }

        case "/resume": {
        requireRole(tgUser, ["USER", "ADMIN"]);

        
        await pauseAccountsByUser(user.userId, false);  // resume

        return bot.sendMessage(chatId, "Trading resumed.");
        }

        case "/accounts": {
        requireRole(tgUser, ["ADMIN"]);

        const accounts = await listAccounts();
        if (!accounts.length) {
            return bot.sendMessage(chatId, "No accounts found.");
        }

        let text = "Accounts:\n\n";
        for (const acc of accounts) {
            text +=
            `• ${acc.accountId}\n` +
            `  Enabled: ${acc.enabled}\n` +
            `  UserPaused: ${acc.userPaused}\n` +
            `  Lot: ${acc.fixedLot}\n\n`;
        }

        return bot.sendMessage(chatId, text);
        }

        case "/lot": {
        requireRole(tgUser, ["ADMIN"]);

        const [, accountId, lotStr] = msg.text.split(" ");
        const lot = Number(lotStr);

        if (!accountId || !lot || lot <= 0) {
            return bot.sendMessage(chatId, "Usage: /lot <accountId> <value>");
        }

        await setLotSize(accountId, lot);

        return bot.sendMessage(
            chatId,
            `Lot size updated.\nAccount: ${accountId}\nNew Lot: ${lot}`
        );
        }

        case "/enable": {
        requireRole(tgUser, ["ADMIN"]);

        const [, accountId] = msg.text.split(" ");
        if (!accountId) {
            return bot.sendMessage(chatId, "Usage: /enable <accountId>");
        }

        await setAccountEnabled(accountId, true);

        return bot.sendMessage(chatId, `Trading ENABLED for ${accountId}`);
        }

        case "/disable": {
        requireRole(tgUser, ["ADMIN"]);

        const [, accountId] = msg.text.split(" ");
        if (!accountId) {
            return bot.sendMessage(chatId, "Usage: /disable <accountId>");
        }

        await setAccountEnabled(accountId, false);

        return bot.sendMessage(chatId, `Trading DISABLED for ${accountId}`);
        }

        case "/status": {
        requireRole(tgUser, ["USER", "ADMIN"]);

        const account = await getAccountById(process.env.METAAPI_ACCOUNT_ID);

        if (!account) {
            return bot.sendMessage(chatId, "Account not found.");
        }

        const status = `
    Account: ${account.accountId}
    Enabled: ${account.enabled}
    Paused: ${account.userPaused}
    Lot: ${tgUser.role === "ADMIN" ? account.fixedLot : "Restricted"}
        `;

        return bot.sendMessage(chatId, status);
        }

        case "/pending_users": {
            requireRole(tgUser, ["ADMIN"]);

            const pending = await listPendingUsers();
            if (!pending.length) {
                return bot.sendMessage(chatId, "No pending users.");
            }

            let text = "Pending users:\n\n";
            for (const u of pending) {
                text += `• ${u.telegramId} (${u.username || "no username"})\n`;
            }

            return bot.sendMessage(chatId, text);
        }

        case "/approve": {
            requireRole(tgUser, ["ADMIN"]);

            const [, tgId] = msg.text.split(" ");
            if (!tgId) {
                return bot.sendMessage(chatId, "Usage: /approve <telegramId>");
            }

            const pendingUsers = await listPendingUsers();
            const pending = pendingUsers.find(u => u.telegramId === Number(tgId));


            if (!pending) {
                return bot.sendMessage(chatId, "Pending user not found.");
            }

            const userId = await createUserFromPending(pending);
            await removePendingUser(Number(tgId));

            return bot.sendMessage(
                chatId,
                `User approved.\nTelegram ID: ${tgId}\nUser ID: ${userId}`
            );
        }

        case "/reject": {
            requireRole(tgUser, ["ADMIN"]);

            const [, tgId] = msg.text.split(" ");
            if (!tgId) {
                return bot.sendMessage(chatId, "Usage: /reject <telegramId>");
            }

            await removePendingUser(Number(tgId));

            return bot.sendMessage(chatId, `User ${tgId} rejected.`);
        }

        case "/assign_account": {
            requireRole(tgUser, ["ADMIN"]);

            const [, tgId, accountId] = msg.text.split(" ");
            if (!tgId || !accountId) {
                return bot.sendMessage(
                chatId,
                "Usage: /assign_account <telegramId> <accountId>"
                );
            }

            await assignAccountToUser({
                telegramId: Number(tgId),
                accountId
            });

            return bot.sendMessage(
                chatId,
                `Account assigned.\nTelegram ID: ${tgId}\nAccount: ${accountId}\n\nTrading is DISABLED by default.`
            );
        }

        case "/unassign_account": {
            requireRole(tgUser, ["ADMIN"]);

            const [, accountId] = msg.text.split(" ");
            if (!accountId) {
                return bot.sendMessage(chatId, "Usage: /unassign_account <accountId>");
            }

            await unassignAccount(accountId);

            return bot.sendMessage(
                chatId,
                `Account ${accountId} unassigned and removed.`
            );
        }

        case "/my_account": {
            requireRole(tgUser, ["USER", "ADMIN"]);

            const accounts = await getAccountsByUser(user.userId);

            if (!accounts.length) {
                return bot.sendMessage(
                chatId,
                "No trading account is assigned to you yet.\nPlease contact the admin."
                );
            }

            let text = "Your account details:\n\n";

            for (const acc of accounts) {
                text +=
                `Account ID: ${acc.accountId}\n` +
                `Broker: ${acc.broker}\n` +
                `Symbol: ${acc.symbol}\n` +
                `Trading Enabled: ${acc.enabled ? "YES" : "NO"}\n` +
                `Paused: ${acc.userPaused ? "YES" : "NO"}\n\n`;
            }

            return bot.sendMessage(chatId, text);
        }

        case "/users": {
            requireRole(tgUser, ["ADMIN"]);

            const users = await listUsers();
            if (!users.length) {
                return bot.sendMessage(chatId, "No users found.");
            }

            const accountsByUser = await getAccountsGroupedByUser();
            const telegramMap = await getTelegramUsersMap();

            let text = "Registered users:\n\n";

            for (const u of users) {
                const accounts = accountsByUser.get(u.userId) || [];
                const tgId = telegramMap.get(u.userId) || "N/A";

                text += `User ID: ${u.userId}\n`;
                text += `Telegram ID: ${tgId}\n`;
                text += `Enabled: ${u.enabled ? "YES" : "NO"}\n`;

                if (!accounts.length) {
                text += `Accounts: none\n\n`;
                continue;
                }

                text += `Accounts:\n`;
                for (const acc of accounts) {
                text +=
                    ` • ${acc.accountId} | ` +
                    `Enabled: ${acc.enabled ? "YES" : "NO"} | ` +
                    `Paused: ${acc.userPaused ? "YES" : "NO"}\n`;
                }

                text += `\n`;
            }

            return bot.sendMessage(chatId, text);
        }



        default: {
            const helpText = renderHelp(tgUser.role);
            return bot.sendMessage(chatId, helpText);
        }

    }
  } catch (err) {
    return bot.sendMessage(chatId, err.message || "Command failed.");
  }
});

  return bot;
}

function getBot() {
  if (!bot) {
    throw new Error("Telegram bot not initialized. Call initTelegramBot() first.");
  }
  return bot;
}

module.exports = { initTelegramBot, getBot };

