/**
 * Node identity: ed25519 keypairs via node:crypto (no dependencies).
 * A kiln node id is hex(sha256(raw 32-byte ed25519 public key)).
 * It is NOT an Ethereum address — never present it as one.
 */
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { sha256hex } from "./canon.mjs";

function rawPubkey(spkiDer) {
  // SPKI DER for ed25519 ends with the 32-byte raw public key.
  if (spkiDer.length < 32) throw new Error("keys: bad SPKI length");
  return spkiDer.subarray(spkiDer.length - 32);
}

export function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubSpkiDer = publicKey.export({ type: "spki", format: "der" });
  const privPkcs8Der = privateKey.export({ type: "pkcs8", format: "der" });
  const pubRaw = rawPubkey(pubSpkiDer);
  return {
    id: sha256hex(pubRaw), // kiln node id
    pubSpkiB64: pubSpkiDer.toString("base64"),
    privPkcs8B64: privPkcs8Der.toString("base64"),
    pubRawHex: Buffer.from(pubRaw).toString("hex"),
  };
}

export function loadKeypair(stored) {
  const priv = createPrivateKey({
    key: Buffer.from(stored.privPkcs8B64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const pub = createPublicKey({
    key: Buffer.from(stored.pubSpkiB64, "base64"),
    format: "der",
    type: "spki",
  });
  const pubRaw = rawPubkey(pub.export({ type: "spki", format: "der" }));
  return {
    id: sha256hex(pubRaw),
    signText(text) {
      return sign(null, Buffer.from(text, "utf8"), priv).toString("hex");
    },
    verifyText(text, sigHex) {
      return verify(null, Buffer.from(text, "utf8"), pub, Buffer.from(sigHex, "hex"));
    },
    pubRawHex: Buffer.from(pubRaw).toString("hex"),
  };
}
