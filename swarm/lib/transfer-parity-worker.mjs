// Worker: compute Reed-Solomon parity for one stripe off the main thread.
import { parentPort } from "node:worker_threads";
import { encodeParity } from "./transfer-rs.mjs";
parentPort.on("message", ({ id, buf, lens, m, shardLen }) => {
  const data = []; let off = 0;
  const u = Buffer.from(buf);
  for (const l of lens) { data.push(u.subarray(off, off + l)); off += l; }
  const parity = encodeParity(data, m, shardLen);
  const out = parity.map((p) => p.buffer.slice(p.byteOffset, p.byteOffset + p.length));
  parentPort.postMessage({ id, buf, parity: out }, [buf, ...out]);
});
