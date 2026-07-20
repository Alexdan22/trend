const ALWAYS_FORBIDDEN_KEYS = Object.freeze([
  "account", "accountid", "userid", "user", "broker", "chat", "chatid",
  "credential", "credentials", "token", "apikey", "api_key", "secret",
  "ticket", "order", "orderid", "position", "positionid", "tradeid",
  "signaleventid",
]);

const SECRET_PATTERN = /(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._-]{12,}|mongodb(?:\+srv)?:\/\/)/i;

class RedactionRejectedError extends Error {
  constructor(stage, path, reason) {
    super(`AI ${stage} payload rejected at ${path || "root"}: ${reason}`);
    this.name = "RedactionRejectedError";
    this.stage = stage;
    this.path = path;
  }
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function assertPrivateIdentifiersAbsent(value, stage, path = "root") {
  if (typeof value === "string" && SECRET_PATTERN.test(value)) {
    throw new RedactionRejectedError(stage, path, "credential-like value");
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPrivateIdentifiersAbsent(item, stage, `${path}[${index}]`));
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (ALWAYS_FORBIDDEN_KEYS.some((forbidden) => normalized === forbidden || normalized.endsWith(forbidden))) {
      throw new RedactionRejectedError(stage, `${path}.${key}`, "forbidden identifier field");
    }
    assertPrivateIdentifiersAbsent(child, stage, `${path}.${key}`);
  }
  return value;
}

module.exports = { ALWAYS_FORBIDDEN_KEYS, RedactionRejectedError, assertPrivateIdentifiersAbsent };
