const crypto = require("crypto");

function omitUndefinedProperties(value) {
  if (value === undefined) return undefined;
  if (value instanceof Date || Buffer.isBuffer(value) || value?._bsontype) return value;
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : omitUndefinedProperties(item));
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.entries(value).reduce((result, [key, child]) => {
      if (child !== undefined) result[key] = omitUndefinedProperties(child);
      return result;
    }, {});
  }
  return value;
}

function normalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { $binarySha256: sha256(value), subType: 0 };
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
  return JSON.stringify(normalize(omitUndefinedProperties(value)));
}

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash("sha256").update(input).digest("hex");
}

function withCanonicalHash(document) {
  const clean = omitUndefinedProperties(document);
  const canonicalHash = sha256(JSON.stringify(normalize(clean)));
  return Object.freeze({ ...clean, canonicalHash });
}

module.exports = { canonicalJson, normalize, omitUndefinedProperties, sha256, withCanonicalHash };
