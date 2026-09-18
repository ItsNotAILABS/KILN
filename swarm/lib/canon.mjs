/**
 * Canonical JSON + sha256 helpers.
 * Canonical form: JSON with object keys sorted recursively, no whitespace.
 * Used for receipts, queue digests, and node ids. No dependencies.
 */
import { createHash } from "node:crypto";

export function canon(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error("canon: non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (t === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (value[k] === undefined) continue;
      out[k] = canonicalize(value[k]);
    }
    return out;
  }
  throw new Error(`canon: unsupported type ${t}`);
}

export function sha256hex(input) {
  const h = createHash("sha256");
  if (typeof input === "string") h.update(input, "utf8");
  else h.update(input);
  return h.digest("hex");
}

export function sha256hexOfCanon(value) {
  return sha256hex(canon(value));
}
