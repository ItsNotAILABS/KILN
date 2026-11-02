/**
 * Rotating append log for app stdout/stderr (2026-10-17).
 *
 * A deployed app's log used to be one fd appended forever — unbounded
 * growth on the node's disk for the app's whole lifetime. This writer
 * rotates at a byte threshold: app.log → app.log.1 → app.log.2 (oldest
 * dropped). An already-oversized file rotates on open, so logs written
 * before this existed converge on the first boot.
 *
 * Implementation is deliberately synchronous (appendFileSync per
 * chunk): app log volume is modest, and sync appends make rotation
 * exact — no stream buffers racing the renames. Single writer per
 * file (the worker's app supervisor).
 */
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";

export const APP_LOG_MAX_BYTES = Math.max(
  16 * 1024,
  Number(process.env.KILN_APP_LOG_MAX_BYTES) || 10 * 1024 * 1024,
);
export const APP_LOG_KEEP = 2;

export function createRotatingLog(path, { maxBytes = APP_LOG_MAX_BYTES, keep = APP_LOG_KEEP } = {}) {
  let bytes = 0;
  let rotations = 0;

  function rotateFiles() {
    try {
      const oldest = `${path}.${keep}`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = keep - 1; i >= 1; i--) {
        if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      }
      if (existsSync(path)) renameSync(path, `${path}.1`);
    } catch { /* rotation is best-effort; logging continues on the old file */ }
    bytes = 0;
    rotations += 1;
  }

  if (existsSync(path)) {
    try { bytes = statSync(path).size; } catch { bytes = 0; }
    if (bytes >= maxBytes) rotateFiles();
  }
  // The log exists from the moment supervision starts (the pre-rotation
  // code opened the fd at spawn) — watchers poll for its existence.
  if (!existsSync(path)) {
    try { appendFileSync(path, ""); } catch { /* best effort */ }
  }

  return {
    write(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (bytes > 0 && bytes + buf.length >= maxBytes) rotateFiles();
      try { appendFileSync(path, buf); } catch { /* a dead log must never kill the supervisor */ }
      bytes += buf.length;
    },
    end() { /* synchronous writer: nothing to flush */ },
    get rotations() { return rotations; },
    get bytes() { return bytes; },
  };
}
