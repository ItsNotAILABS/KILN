/**
 * transfer-rs.mjs — systematic Reed-Solomon erasure coding over GF(2^8).
 * Pure JS, zero dependencies.
 *
 * A stripe ("FEC set" in Solana Turbine terms) has k data shards and m
 * parity shards. Any k of the k+m shards rebuild the k data shards. The
 * encoding matrix is [I_k ; C] where C is an m×k Cauchy matrix, so every
 * k×k submatrix is invertible (k + m <= 256).
 */
const POLY = 0x11d;
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= POLY;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
export function gfMul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }
export function gfInv(a) { if (a === 0) throw new Error("GF(256): inverse of 0"); return EXP[255 - LOG[a]]; }

/** MUL[c * 256 + x] = c·x — one 256-byte row per coefficient. */
const MUL = new Uint8Array(65536);
for (let c = 0; c < 256; c++) for (let x = 0; x < 256; x++) MUL[(c << 8) | x] = gfMul(c, x);

/** Row r (0..m-1) of the Cauchy parity matrix for k data shards. */
function cauchyRow(r, k) {
  const row = new Uint8Array(k);
  for (let j = 0; j < k; j++) row[j] = gfInv((k + r) ^ j);
  return row;
}

/** Matrix row for shard index idx: identity for data, Cauchy for parity. */
function encodingRow(idx, k) {
  if (idx < k) { const r = new Uint8Array(k); r[idx] = 1; return r; }
  return cauchyRow(idx - k, k);
}

/** dst ^= c · src over len bytes. */
function mulAddInto(dst, src, c, len) {
  if (c === 0) return;
  const n = Math.min(len, src.length);
  if (c === 1) { for (let t = 0; t < n; t++) dst[t] ^= src[t]; return; }
  const base = c << 8;
  for (let t = 0; t < n; t++) dst[t] ^= MUL[base | src[t]];
}

export function checkParams(k, m) {
  if (!Number.isInteger(k) || k < 1) throw new Error("reed-solomon: k must be >= 1");
  if (!Number.isInteger(m) || m < 0) throw new Error("reed-solomon: m must be >= 0");
  if (k + m > 256) throw new Error("reed-solomon: k + m must be <= 256");
}

/**
 * Compute m parity shards of length shardLen from k data shards. Data
 * shards shorter than shardLen are treated as zero-padded.
 */
export function encodeParity(data, m, shardLen) {
  const k = data.length;
  checkParams(k, m);
  const out = [];
  for (let r = 0; r < m; r++) {
    const row = cauchyRow(r, k);
    const p = Buffer.alloc(shardLen);
    for (let j = 0; j < k; j++) mulAddInto(p, data[j], row[j], shardLen);
    out.push(p);
  }
  return out;
}

function invertMatrix(rows, k) {
  const a = rows.map((r) => Uint8Array.from(r));
  const inv = Array.from({ length: k }, (_, i) => { const r = new Uint8Array(k); r[i] = 1; return r; });
  for (let col = 0; col < k; col++) {
    let piv = col;
    while (piv < k && a[piv][col] === 0) piv++;
    if (piv === k) throw new Error("reed-solomon: singular decode matrix");
    [a[col], a[piv]] = [a[piv], a[col]];
    [inv[col], inv[piv]] = [inv[piv], inv[col]];
    const s = gfInv(a[col][col]);
    for (let j = 0; j < k; j++) { a[col][j] = gfMul(a[col][j], s); inv[col][j] = gfMul(inv[col][j], s); }
    for (let r = 0; r < k; r++) {
      if (r === col || a[r][col] === 0) continue;
      const f = a[r][col];
      for (let j = 0; j < k; j++) { a[r][j] ^= gfMul(f, a[col][j]); inv[r][j] ^= gfMul(f, inv[col][j]); }
    }
  }
  return inv;
}

/**
 * Rebuild missing data shards.
 *   shards: Map<index, Buffer> with at least k entries (index < k = data,
 *           >= k = parity). Data shards may be short (zero-padded).
 *   returns Map<dataIndex, Buffer(shardLen)> for every missing data index.
 */
export function reconstructData(shards, k, m, shardLen) {
  checkParams(k, m);
  const missing = [];
  for (let i = 0; i < k; i++) if (!shards.has(i)) missing.push(i);
  if (missing.length === 0) return new Map();
  const use = [...shards.keys()].filter((i) => i < k + m).sort((a, b) => a - b).slice(0, k);
  if (use.length < k) throw new Error(`reed-solomon: need ${k} shards, have ${use.length}`);
  const inv = invertMatrix(use.map((i) => encodingRow(i, k)), k);
  const out = new Map();
  for (const d of missing) {
    const buf = Buffer.alloc(shardLen);
    for (let j = 0; j < k; j++) mulAddInto(buf, shards.get(use[j]), inv[d][j], shardLen);
    out.set(d, buf);
  }
  return out;
}
