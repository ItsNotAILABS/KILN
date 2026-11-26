/**
 * Keccak-256 (Ethereum / pre-NIST SHA-3 padding). Not Node's sha3-256.
 * 0 dependencies. Vectors: empty -> c5d24601… (Ethereum empty-code hash);
 * "abc" -> 4e03657aea45a94f…; transfer(address,uint256) selector a9059cbb.
 */
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(x, n) {
  n %= 64;
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & 0xffffffffffffffffn;
}

function permute(st) {
  for (let r = 0; r < 24; r++) {
    const C = [];
    for (let x = 0; x < 5; x++) C[x] = st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20];
    const D = [];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let i = 0; i < 25; i++) st[i] ^= D[i % 5];
    const B = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + ((2 * x + 3 * y) % 5) * 5] = rotl(st[x + y * 5], ROT[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const not1 = B[((x + 1) % 5) + y * 5] ^ 0xffffffffffffffffn;
        st[x + y * 5] = (B[x + y * 5] ^ (not1 & B[((x + 2) % 5) + y * 5])) & 0xffffffffffffffffn;
      }
    }
    st[0] ^= RC[r];
  }
}

export function keccak256(data) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const st = new Array(25).fill(0n);
  const rate = 136; // 1088 bits for keccak256
  let off = 0;
  const block = Buffer.alloc(rate);
  while (off < input.length) {
    const n = Math.min(rate, input.length - off);
    input.copy(block, 0, off, off + n);
    if (n < rate) block.fill(0, n);
    // absorb full blocks; leftover handled below
    if (n === rate) {
      for (let i = 0; i < 17; i++) st[i] ^= block.readBigUInt64LE(i * 8);
      permute(st);
      off += n;
    } else {
      break;
    }
  }
  const rem = input.length - off;
  block.fill(0);
  if (rem) input.copy(block, 0, off);
  // keccak pad: domain 0x01, then 10*1
  block[rem] ^= 0x01;
  block[rate - 1] ^= 0x80;
  for (let i = 0; i < 17; i++) st[i] ^= block.readBigUInt64LE(i * 8);
  permute(st);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(st[i], i * 8);
  return out;
}

export function keccak256Hex(data) {
  return keccak256(data).toString("hex");
}
