// Worker: SHA-256 a contiguous range of chunks [from, to) of one file.
import { workerData, parentPort } from "node:worker_threads";
import { openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
const { path, chunkSize, size, from, to } = workerData;
const fd = openSync(path, "r");
const buf = Buffer.allocUnsafe(chunkSize);
const out = [];
try {
  for (let c = from; c < to; c++) {
    const pos = c * chunkSize, want = Math.min(chunkSize, size - pos);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, pos + got);
      if (n === 0) throw new Error("file shrank while hashing");
      got += n;
    }
    out.push(createHash("sha256").update(buf.subarray(0, want)).digest("hex"));
  }
} finally { closeSync(fd); }
parentPort.postMessage(out);
