const crypto = require("crypto");

function normalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { $binarySha256: sha256(value) };
  if (value?._bsontype === "Binary" && value.buffer) {
    return { $binarySha256: sha256(Buffer.from(value.buffer)), subType: value.sub_type ?? 0 };
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .filter((key) => key !== "_id" && key !== "canonicalHash")
      .sort()
      .reduce((result, key) => {
        if (value[key] !== undefined) result[key] = normalize(value[key]);
        return result;
      }, {});
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash("sha256").update(input).digest("hex");
}

function withCanonicalHash(document) {
  const clean = normalize(document);
  return Object.freeze({ ...document, canonicalHash: sha256(JSON.stringify(clean)) });
}

module.exports = { canonicalJson, normalize, sha256, withCanonicalHash };
