#!/usr/bin/env node
/**
 * Example: ANOTHER repo using KILN as serverless compute.
 * Pretend this file lives in some other project — all it needs is the
 * ComputeClient and a running KILN daemon. No KILN repo code besides the SDK.
 *
 *   node examples/compute-invoke.mjs
 */
import { ComputeClient } from "../lib/compute-client.mjs";

const kiln = await ComputeClient.connect();
console.log("connected to", (await kiln.health()).service);

// 1. One function, synchronous: price a batch of minute-contracts offloaded
//    from the caller's hot path.
const priced = await kiln.invoke({
  name: "price-batch",
  code: `
    export async function main(contracts) {
      // premium = base * sqrt(minutes) * volFactor, rounded to 6dp
      return contracts.map((c) => ({
        id: c.id,
        premium: Math.round(c.base * Math.sqrt(c.minutes) * c.vol * 1e6) / 1e6,
      }));
    }`,
  args: [
    { id: "a", base: 0.42, minutes: 5, vol: 1.1 },
    { id: "b", base: 0.87, minutes: 15, vol: 0.9 },
  ],
  waitMs: 60000,
});
console.log("invoke:", priced.status, "ok=", priced.ok, JSON.stringify(priced.result));

// 2. The supercomputer bit: fan a CPU-heavy scan across swarm workers.
const N = 8;
const scanned = await kiln.waitMap(
  (
    await kiln.map({
      name: "prime-scan",
      code: `
        export async function main({ lo, hi }) {
          const primes = [];
          for (let n = Math.max(2, lo); n <= hi; n++) {
            let p = true;
            for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; }
            if (p) primes.push(n);
          }
          return { lo, hi, count: primes.length };
        }`,
      items: Array.from({ length: N }, (_, i) => ({ lo: i * 25000, hi: (i + 1) * 25000 - 1 })),
      timeoutMs: 120000,
    })
  ).mapId,
  { timeoutMs: 180000 }
);
const total = scanned.results.reduce((s, r) => s + r.result.count, 0);
console.log(`map: ${scanned.results.length} shards done in parallel, ${total} primes found`);
for (const r of scanned.results) {
  console.log(`  shard ${r.invocationId.slice(4, 10)}: ${r.result.count} primes (${r.durationMs}ms)`);
}
