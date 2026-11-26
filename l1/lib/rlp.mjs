/** Minimal RLP encoder for unsigned/signed Ethereum legacy transactions. */
function encLen(length, offset) {
  if (length < 56) return Buffer.from([offset + length]);
  const hex = length.toString(16).padStart(2, "0");
  const lenBytes = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}

export function rlpEncode(value) {
  if (value == null) return rlpEncode(Buffer.alloc(0));
  if (Array.isArray(value)) {
    const body = Buffer.concat(value.map(rlpEncode));
    return Buffer.concat([encLen(body.length, 0xc0), body]);
  }
  let buf;
  if (typeof value === "bigint" || (typeof value === "number" && Number.isFinite(value))) {
    let n = BigInt(value);
    if (n < 0n) throw new Error("rlp: negative");
    if (n === 0n) buf = Buffer.alloc(0); // integer 0 is empty byte string
    else {
      let hex = n.toString(16);
      if (hex.length % 2) hex = "0" + hex;
      buf = Buffer.from(hex, "hex");
    }
  } else if (typeof value === "string") {
    const s = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
    buf = Buffer.from(s.length % 2 ? "0" + s : s, "hex");
  } else {
    buf = Buffer.from(value);
  }
  if (buf.length === 1 && buf[0] < 0x80) return buf;
  return Buffer.concat([encLen(buf.length, 0x80), buf]);
}
