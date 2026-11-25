# KILN agent transfer

Agent-to-agent file and package transfer: zips, tarballs, model weights, or
whole directories, any size, moved directly between two agents (or into and
out of a [virtual computer](KILN_VIRTUAL_COMPUTERS.md)'s home). The design
borrows from Solana's networking: Turbine-style erasure-coded stripes spread
across parallel streams, ed25519 identities in Solana's key format, and an
optional Solana Memo receipt. **File bytes never go on chain.**

```bash
# receiver (prints {"event":"listening","address":"127.0.0.1:41234","publicKey":"7yfD…"})
node swarm/swarm.mjs recv --out ./inbox

# sender
node swarm/swarm.mjs send ./release.zip --to 127.0.0.1:41234 --expect 7yfD…
```

```js
import { startReceiver, sendPath, loadIdentity } from "<kiln>/swarm/lib/transfer.mjs";
const rx = await startReceiver({ outDir: "./inbox", keypair: loadIdentity(stateDir), trust: [senderPubkey] });
const r  = await sendPath("./build", { host, port: rx.port, keypair: myKeypair, expectReceiver: rx.publicKey });
// r.throughputMBps, r.result.path, r.skippedStripes (resume), r.repairRounds …
```

## How it works

1. **Hash pass (sender).** The file is read from disk in `chunkSize` pieces
   (default 1 MiB), split across up to 4 worker threads. Every chunk gets a
   SHA-256. Memory per worker is one chunk.
2. **Manifest.** `{type, name, size, chunkSize, dataShards k, parityShards m,
   chunks[sha256…], root, sender, mtime}`. `root` is the SHA-256 over all chunk
   hashes. The manifest id is the SHA-256 of its canonical JSON (sorted keys),
   so manifests are content-addressed. The sender signs
   `"kiln-transfer/1:" + id` with its ed25519 key.
3. **Handshake.** One control connection carries `HELLO {manifest, signature,
   nonce}`. The receiver checks the signature, the hash list and the root,
   plus the optional `trust` list, then replies `WELCOME {session, receiver
   pubkey, signature over the nonce, have-bitmap}`. The sender checks the
   receiver's signature and, with `--expect`, the key it is pinned to.
4. **Stripes on parallel streams.** k consecutive chunks form a stripe (a
   Turbine "FEC set"). The sender reads a stripe and computes m Reed-Solomon
   parity shards (GF(2^8), Cauchy matrix, pure JS, off the main thread). It
   then sends shard j of stripe s on connection (s + j) mod N, so losing one
   connection costs each stripe at most ⌈(k+m)/N⌉ shards. Data connections
   join with the session id. The default is N = 8 data connections, k = 16,
   m = 2 (12.5% parity overhead).
5. **Receive.** Each data shard is hashed and checked against the manifest
   *before* it is written. A mismatch is dropped and counted, so corrupt
   bytes never reach disk. Good shards go to their offset in a sparse
   `.kiln-recv/<id>.part` file with positional writes. A stripe is done when
   all k data shards are on disk. Parity is kept only for unfinished
   stripes. Sockets are paused when more than 64 MiB of writes are pending
   (backpressure).
6. **Recover / repair.** At the end, any stripe that is missing data but has
   at least k shards is rebuilt from parity. The rebuilt chunks must match
   their hashes, which also catches corrupt parity. Anything still missing
   comes back as a `MISSING` bitmap, and the sender resends just those
   stripes, for up to 8 rounds.
7. **Finish.** The receiver fsyncs, renames to `<out>/<name>` (it never
   clobbers an existing file unless `--overwrite`; otherwise it writes
   `<name>.<id8>`) and replies `COMPLETE`. `--verify` re-hashes every chunk
   on disk first.

**Resume.** The receiver keeps a stripe bitmap in `.kiln-recv/<id>.json`,
written at most every 250 ms. Re-running the same `send` (same file, same
mtime, same key, so the same manifest id) gets that bitmap in `WELCOME` and
skips finished stripes. This works after a killed sender, a killed
receiver, or a dropped network. *Caveat:* a stripe counts as done once its
writes return. They have reached the OS page cache but are not yet
fsynced, so after a power loss (not a process crash) the last ~250 ms of
stripes could be wrong. A resumed transfer always ends with the normal
completion and `--verify` will catch it.

**No size limit / constant memory.** Both sides stream from and to disk.
Offsets are 64-bit-safe up to 2^53 bytes. Memory is bounded by the
pipeline depth (workers + 2 stripes of k × chunkSize), the socket buffers,
and the 64 MiB write cap. It does **not** grow with file size. Measured: a
1 GiB send peaked at about 458 MB RSS on the sender and 224 MB on the
receiver, and a 4 GiB send at 509 MB and 252 MB. Most of the sender's RSS
is Node itself plus four worker threads. The manifest is metadata only and
grows at 64 bytes of hex per chunk, which is about 64 KiB per GiB at the
default chunk size.

**Directories.** `send <dir>` streams the directory into a `.tar` in a temp
staging dir, using disk rather than memory, and sends that. `recv
--extract` unpacks it on arrival. Zips and tars send as-is.

## Transport: why TCP, not QUIC (measured)

The brief asked for QUIC if it is usable. What we found on this box (Node
v24.22.1, 8 vCPU):

- **Node has no built-in QUIC in v24.** `require("node:quic")` and
  `--experimental-quic` both fail with `ERR_UNKNOWN_BUILTIN_MODULE`.
- **The best-maintained userland QUIC, `@matrixai/quic` 2.0.9** (Cloudflare
  quiche via N-API), works but is slow under Node. Over loopback, with 8
  streams, 1 MiB writes, and flow-control windows raised to 64 MiB / 16 MiB,
  it measured **1.6 MiB/s for 256 MiB** and **1.3 MiB/s for 128 MiB**. A
  64 B stream round trip took 3.14 ms / 2.11 ms at p50. Reproduce with
  `swarm/scripts/transfer-quic-probe.mjs` (the dependency is installed
  outside the repo).
- **Parallel TCP on the same box** moves the same data at about 560 to
  620 MiB/s, roughly 400× faster, with no dependency.

So the shipped transport is **parallel TCP**: N independent TCP
connections with length-prefixed frames and `TCP_NODELAY`. Running
separate connections, rather than HTTP/2 streams on one connection, keeps
one slow or lost connection from stalling the others, which is the point
of spreading shards. It sits behind a small transport interface
(`listen` / `connect` / framed `conn` in `swarm/lib/transfer-wire.mjs`,
registry `TRANSPORTS`). A QUIC transport can be added there without
touching chunking, erasure coding, manifests or resume once Node ships
`node:quic` (or a faster binding exists). Erasure coding still matters on
TCP: it absorbs dropped connections, corrupt shards and partial sends
without a round trip.

What TCP does not give you that QUIC would: TLS built in, connection
migration, and a single 0-RTT handshake. See Security below.

## Benchmarks (measured, not estimated)

`node swarm/scripts/transfer-bench.mjs --mb 1024 --runs 5`. The receiver is
a separate `swarm.mjs recv` process and the sender is the bench process.
This is one host over 127.0.0.1 with the source in page cache, so these are
**loopback / CPU numbers, not a network-link measurement**. Over a real
link expect the link speed to be the cap. Box: 8 vCPU Intel Xeon, 15 GB
RAM, Node v24.22.1, 2026-11-25. Medians of 5 runs:

| config | wire MiB/s | wire s | hash s | end-to-end MiB/s | wire/file bytes | sender peak RSS MB |
|---|---|---|---|---|---|---|
| 8 streams, RS 16+2 (default) | 561.9 | 1.822 | 0.234 | 492.5 | 1.125 | 471 |
| 8 streams, no parity | 620.3 | 1.651 | 0.235 | 543 | 1 | 471 |
| 4 streams, RS 16+2 | 537.6 | 1.905 | 0.224 | 480.3 | 1.125 | 514 |
| 1 stream, RS 16+2 | 487.8 | 2.099 | 0.245 | 428.2 | 1.125 | 536 |

- Small-message latency: a 64 B ping on an open connection measured
  **p50 0.023 ms, p99 0.174 ms** (n = 1000).
- A **1 KiB file, full send** (connect, signed manifest, verify, write,
  fsync, rename, confirm) measured **p50 3.88 ms, p99 9.96 ms** (n = 100).
  Single-stripe files skip the extra data connections and worker threads.
- End-to-end CLI test (`test/transfer-e2e.test.mjs`, two processes,
  1 GiB): hash 0.26 s, wire 2.26 s, 452 MiB/s.
- With 8 streams on loopback the bottleneck is CPU (SHA-256 on receive,
  parity on send, and copies), not the sockets.

## On-chain receipt (optional, off by default)

`swarm.mjs transfer receipt --manifest-id <id>` builds a Solana legacy
transaction. The payer is your transfer key, there is one Memo-program
instruction (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) with memo
`kiln-transfer:<manifestId>`, and the transaction is signed offline. It is
**not sent.** It was checked against `@solana/web3.js` (`Transaction.from`
→ `verifySignatures() === true`, correct fee payer, program and memo). Only
the 32-byte manifest hash would ever go on chain.

`--submit --rpc <url>` sends it, but only to `https://api.devnet.solana.com`,
`https://api.testnet.solana.com`, or `http://127.0.0.1|localhost:<port>`
(solana-test-validator). Mainnet and every other URL are refused in code
(`checkRpcUrl`). The payer needs devnet/local SOL first (`solana airdrop 1
<pubkey> -u devnet`). **Not done:** a live devnet/local-validator
submission. Devnet airdrops need an outside faucet, and the box has no
`solana-test-validator`. The offline build plus web3.js verification is
what was tested.

## Identities

`swarm.mjs transfer identity` prints your transfer public key. The key is
created on first use at `<stateDir>/transfer/id.json` with mode 0600, in
`solana-keygen` format: a JSON array of 64 bytes, the seed followed by the
pubkey. Any Solana keypair file works with `--keypair FILE`, and a key made
here loads in `solana-keygen`. The public key is the base58 Solana address.

## VC homes

```bash
swarm.mjs recv --vc agent-1 --subdir inbox [--extract]   # lands in ~/inbox inside the computer
swarm.mjs send inbox/report.zip --from-vc agent-1 --to HOST:PORT
```

SDK: `receiveIntoComputer(stateDir, ref, {subdir, extract, keypair})` and
`sendFromComputer(stateDir, ref, relPath, opts)`.

- With the local backend, transfers read and write the host-side home
  directly.
- With the docker backend, received files land in
  `<stateDir>/transfer/staging/<vc>` and are then `docker cp`'d into
  `/home/agent/<subdir>` and chowned to `agent`. Outgoing files are
  `docker cp`'d out to a temp staging dir. Staging uses disk equal to the
  file size, never RAM.
- Paths are relative to the home, and `..` escapes are refused.

## CLI reference

```
swarm.mjs recv [--out DIR] [--host H] [--port P] [--trust PK,PK] [--keypair FILE]
               [--once] [--extract] [--verify] [--overwrite] [--vc ID --subdir S]
swarm.mjs send <path> --to HOST:PORT [--expect PUBKEY] [--streams N] [--chunk-kb KB]
               [--data K] [--parity M] [--keypair FILE] [--from-vc ID] [--json]
swarm.mjs transfer identity [--keypair FILE]
swarm.mjs transfer ping --to HOST:PORT [--count N]
swarm.mjs transfer receipt --manifest-id ID [--blockhash B58 | --submit --rpc URL]
```

`recv` prints one JSON line per event (`listening`, `received`). `send
--json` prints the stats object, which includes `throughputMBps`,
`transferSeconds`, `hashSeconds`, `skippedStripes`, `repairRounds`,
`wireBytes` and `peakRssMB`.

## Security

- **Integrity and authenticity: yes.** The ed25519-signed manifest, a
  SHA-256 for every chunk checked before writing, a receiver signature over
  the sender's nonce, and optional `--trust` / `--expect` pinning.
- **Confidentiality: no.** Bytes are not encrypted on the wire. `recv`
  binds 127.0.0.1 by default. To cross machines, run it over an SSH tunnel,
  WireGuard or Tailscale, or encrypt the payload first (`age`, `gpg`).
  Only use `--host 0.0.0.0` on a trusted network, and always set
  `--trust`.
- Names are sanitized to a basename, so a manifest cannot write outside
  `--out`.

## Tests

- `test/transfer-unit.test.mjs` (14): base58 and Solana keypairs, ed25519,
  Reed-Solomon recovery with random drops including short last shards,
  geometry, hashing (parallel equals single-thread), canonical ids,
  signed-manifest tamper/foreign-key/trust rejection, and the memo receipt
  plus the mainnet guard.
- `test/transfer.test.mjs` (15): byte-exact delivery, empty and 1-byte
  files, no clobber, ping latency, parity recovery with no resend, repair
  rounds, hash-mismatch rejection, corrupt-parity detection, a dead data
  connection, resume skipping finished stripes, trust and receiver
  pinning, directories as tar, home-escape refusal, and local vc home in
  and out.
- `test/transfer-e2e.test.mjs` (2): **1 GiB** through two real CLI
  processes with a SHA-256 match and bounded RSS, plus a SIGKILLed sender
  that resumes. This drops to 256 MiB when the temp disk has less than
  3.5 GiB free; override with `KILN_TRANSFER_E2E_MB`.
- `test/transfer-vc-docker.test.mjs` (1): into and out of a real docker vc
  home, with the owner checked. It skips when docker or the image is
  missing.

## Not done / limits

- QUIC transport: not shipped (see the measurements above). The interface
  is ready for it.
- No encryption on the wire (see Security).
- No live devnet or local-validator receipt submission.
- No NAT traversal or relay: the receiver must be reachable (directly or
  through a tunnel).
- No daemon HTTP routes. Transfer is peer to peer through the CLI or SDK
  and does not need the swarm daemon.
- A single sender process fans out to one receiver. There is no
  multi-receiver Turbine tree (retransmit layers).
