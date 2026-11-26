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
3. **Encrypted, mutually authenticated handshake (on by default).** Each
   TCP connection starts with an ephemeral X25519 key exchange. Each side
   signs its ephemeral public key (plus a nonce, and on data connections
   the session id) with its long-term ed25519 identity. HKDF-SHA-256,
   bound to both identities and both ephemerals, derives two AES-256-GCM
   keys (one per direction). `--expect` is checked against the receiver's
   signed handshake before any file metadata is sent. After that, every
   frame — including `HELLO` / `WELCOME` and every shard — is
   AES-256-GCM with a 64-bit nonce counter that never wraps or repeats.
   A failed tag, or a reused or out-of-order nonce, closes the
   connection. The 12-byte nonce is 4 zero bytes + a u64be counter
   starting at 1. `--insecure` skips this and is **refused unless both
   sides are on loopback**.
4. **Transfer hello.** The now-encrypted control connection carries
   `HELLO {manifest, signature, nonce}`. The receiver checks the
   signature, the hash list and the root, plus the optional `trust` list,
   and checks that the manifest sender matches the handshake identity,
   then replies `WELCOME {session, receiver pubkey, signature over the
   nonce, have-bitmap}`.
5. **Stripes on parallel streams.** k consecutive chunks form a stripe (a
   Turbine "FEC set"). The sender reads a stripe and computes m Reed-Solomon
   parity shards (GF(2^8), Cauchy matrix, pure JS, off the main thread). It
   then sends shard j of stripe s on connection (s + j) mod N, so losing one
   connection costs each stripe at most ⌈(k+m)/N⌉ shards. Data connections
   join with the session id. The default is N = 8 data connections, k = 16,
   m = 2 (12.5% parity overhead).
6. **Receive.** Each data shard is hashed and checked against the manifest
   *before* it is written. A mismatch is dropped and counted, so corrupt
   bytes never reach disk. Good shards go to their offset in a sparse
   `.kiln-recv/<id>.part` file with positional writes. A stripe is done when
   all k data shards are on disk. Parity is kept only for unfinished
   stripes. Sockets are paused when more than 64 MiB of writes are pending
   (backpressure).
7. **Recover / repair.** At the end, any stripe that is missing data but has
   at least k shards is rebuilt from parity. The rebuilt chunks must match
   their hashes, which also catches corrupt parity. Anything still missing
   comes back as a `MISSING` bitmap, and the sender resends just those
   stripes, for up to 8 rounds.
8. **Finish.** The receiver fsyncs, renames to `<out>/<name>` (it never
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
and the 64 MiB write cap. It does **not** grow with file size. Measured without encryption: a
1 GiB send peaked at about 458 MB RSS on the sender and 224 MB on the
receiver, and a 4 GiB send at 509 MB and 252 MB. With encryption on, the
1 GiB CLI e2e peaked at 673 MB (sender) and 287 MB (receiver). Most of the sender's RSS
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

What TCP does not give you that QUIC would: TLS as the session layer,
connection migration, and a single 0-RTT handshake. Confidentiality and
mutual authentication are provided by the X25519 + AES-256-GCM handshake
above, not by TLS.

## Benchmarks (measured, not estimated)

`node swarm/scripts/transfer-bench.mjs --mb 1024 --runs 5`. The receiver is
a separate `swarm.mjs recv` process and the sender is the bench process.
This is one host over 127.0.0.1 with the source in page cache, so these are
**loopback / CPU numbers, not a network-link measurement**. Over a real
link expect the link speed to be the cap. Box: 8 vCPU Intel Xeon, 15 GB
RAM, Node v24.22.1. Medians of 5 runs. The "before" and "after" columns
were measured back-to-back on 2026-11-25, same box, same binary, the only
change being the default X25519 + AES-256-GCM handshake.

**Before encryption** (plaintext frames; re-run immediately before the
change):

| config | wire MiB/s | wire s | hash s | end-to-end MiB/s | wire/file bytes | sender peak RSS MB |
|---|---|---|---|---|---|---|
| 8 streams, RS 16+2 (default) | 575.5 | 1.779 | 0.258 | 507.2 | 1.125 | 491 |
| 8 streams, no parity | 666.6 | 1.536 | 0.252 | 579.9 | 1 | 491 |
| 4 streams, RS 16+2 | 587.1 | 1.744 | 0.251 | 508.5 | 1.125 | 511 |
| 1 stream, RS 16+2 | 489.3 | 2.093 | 0.25 | 437.6 | 1.125 | 531 |

- 64 B ping on an open connection: p50 **0.028 ms**, p99 0.113 ms (n = 1000).
- 1 KiB file, full send: p50 **4.11 ms**, p99 24.44 ms (n = 100).

**After encryption** (default; every frame AES-256-GCM, X25519 handshake
on each connection):

| config | wire MiB/s | wire s | hash s | end-to-end MiB/s | wire/file bytes | sender peak RSS MB |
|---|---|---|---|---|---|---|
| 8 streams, RS 16+2 (default) | 385.9 | 2.653 | 0.305 | 342.1 | 1.125 | 843 |
| 8 streams, no parity | 454.9 | 2.251 | 0.288 | 403.9 | 1 | 843 |
| 4 streams, RS 16+2 | 426.9 | 2.399 | 0.281 | 377.3 | 1.125 | 843 |
| 1 stream, RS 16+2 | 298 | 3.436 | 0.266 | 277.5 | 1.125 | 847 |

- 64 B ping on an open (already-handshaked) connection: p50 **0.066 ms**,
  p99 0.245 ms (n = 1000).
- 1 KiB file, full send (now includes the X25519 + signed handshake):
  p50 **7.23 ms**, p99 19.49 ms (n = 100).
- End-to-end CLI test with encryption (`test/transfer-e2e.test.mjs`, two
  processes, 1 GiB): hash 0.29 s, wire 2.85 s, 359.0 MiB/s, sender peak
  RSS 673 MB, receiver peak RSS 287 MB. The SHA-256 of the received file
  matched the source.
- Encryption is the new cost: default throughput went from 575.5 to
  385.9 MiB/s on this box (~33% slower), still well above typical WAN
  links. Sender RSS is higher because each shard is copied into an
  AEAD buffer. The bottleneck is still CPU, not the sockets.

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
               [--insecure]
swarm.mjs send <path> --to HOST:PORT [--expect PUBKEY] [--streams N] [--chunk-kb KB]
               [--data K] [--parity M] [--keypair FILE] [--from-vc ID] [--json]
               [--insecure]
swarm.mjs transfer identity [--keypair FILE]
swarm.mjs transfer ping --to HOST:PORT [--count N] [--insecure]
swarm.mjs transfer receipt --manifest-id ID [--blockhash B58 | --submit --rpc URL]
```

`recv` prints one JSON line per event (`listening`, `received`). `send
--json` prints the stats object, which includes `throughputMBps`,
`transferSeconds`, `hashSeconds`, `skippedStripes`, `repairRounds`,
`wireBytes` and `peakRssMB`.

## Security

- **Confidentiality, integrity, and mutual authentication: yes, on by
  default.** Ephemeral X25519 (forward secrecy) is signed by the existing
  ed25519 identities, so a man-in-the-middle that presents the wrong
  identity is rejected. HKDF-SHA-256 derives per-direction AES-256-GCM
  keys bound to both identities and both ephemerals; swapping either id
  changes the key. Every subsequent frame is sealed; a failed tag or a
  reused nonce closes the connection. The manifest, file name, and file
  bytes all travel encrypted. The ed25519-signed manifest and per-chunk
  SHA-256 remain as a second layer, and `--trust` / `--expect` pin the
  long-term keys.
- **Listener.** `recv` still binds 127.0.0.1 by default. To accept
  remote senders, pass `--host 0.0.0.0` (or the address you want to
  listen on). Traffic is encrypted, but you should still set `--trust`
  to the sender keys you will accept, and the sender should pass
  `--expect` with your public key. `--insecure` turns encryption off and
  is refused unless the listener or the destination is loopback
  (127.0.0.1, ::1, localhost).
- Names are sanitized to a basename, so a manifest cannot write outside
  `--out`.

## Tests

- `test/transfer-unit.test.mjs` (18): the original 14, plus AES-256-GCM
  tag rejection, nonce uniqueness and replay refusal, key-derivation
  binding to identities, and the loopback-only insecure guard.
- `test/transfer.test.mjs` (19): the original 15 (including resume, now
  over the encrypted wire), plus default-on encryption, plaintext HELLO
  refusal, insecure-off-loopback refusal, tampered ciphertext rejection,
  and a man-in-the-middle that re-signs the real server ephemeral under
  the wrong identity.
- `test/transfer-e2e.test.mjs` (2): **1 GiB** through two real CLI
  processes with a SHA-256 match and bounded RSS, plus a SIGKILLed sender
  that resumes, both with encryption on. This drops to 256 MiB when the
  temp disk has less than 3.5 GiB free; override with `KILN_TRANSFER_E2E_MB`.
- `test/transfer-vc-docker.test.mjs` (1): into and out of a real docker vc
  home, with the owner checked. It skips when docker or the image is
  missing.

## Not done / limits

- QUIC transport: not shipped (see the measurements above). The interface
  is ready for it.
- No live devnet or local-validator receipt submission.
- No NAT traversal or relay: the receiver must be reachable (directly or
  through a tunnel).
- No daemon HTTP routes. Transfer is peer to peer through the CLI or SDK
  and does not need the swarm daemon.
- A single sender process fans out to one receiver. There is no
  multi-receiver Turbine tree (retransmit layers).
