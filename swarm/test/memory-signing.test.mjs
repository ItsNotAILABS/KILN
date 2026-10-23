/**
 * KILN Memory phase 2: signed events (Ed25519).
 *
 * Proves: writers sign every event type with the state dir's memory
 * key (file mode 0600, never in git); signatures verify standalone
 * from the event alone; a tampered event whose hash chain is intact
 * but whose signature is stale is rejected on read AND on the promote
 * replay path; an unsigned event after the signing epoch is rejected;
 * and a pre-phase-2 unsigned chain stays readable as unsigned-legacy,
 * with the epoch opening at the first signed write. Real git plumbing
 * throughout — hand-forged commits are built the same way the library
 * builds honest ones.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeStateDir } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import { canon } from "../lib/canon.mjs";
import { newKeypair } from "../lib/keys.mjs";
import {
  MEMORY_REF, remember, assertFact, linkMemories, setCore,
  proposeMemory, resolveProposal, loadMemory, recall, memoryStats, verifyMemory, readEvents,
} from "../lib/memory.mjs";
import {
  loadOrCreateMemoryKey, memorySigningPubkey, memorySigningKeyPath,
  verifyEventSignature, verifyEventChain, computeEventHash,
} from "../lib/memory-signing.mjs";
import { listMemoryCommits } from "../lib/promote.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWARM = join(HERE, "..", "swarm.mjs");
const R = ["auro", "sigtest"];

function freshRepo() {
  const dir = makeStateDir();
  createRepo(dir, "auro", "sigtest");
  return dir;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test-forge", GIT_AUTHOR_EMAIL: "forge@kiln.local",
  GIT_COMMITTER_NAME: "test-forge", GIT_COMMITTER_EMAIL: "forge@kiln.local",
};

function g(gd, args, opts = {}) {
  return execFileSync("git", ["--git-dir", gd, ...args], { encoding: "utf8", env: GIT_ENV, ...opts }).trim();
}

/**
 * Append a hand-built event object to the memory ref with raw plumbing
 * (bypassing the library, like an attacker or a pre-phase-2 writer).
 * The caller supplies the event with `hash` already set correctly.
 */
function appendRawEvent(dir, owner, repo, ev) {
  const gd = repoPath(dir, owner, repo);
  let tip = null;
  try { tip = g(gd, ["rev-parse", "-q", "--verify", MEMORY_REF]); } catch { /* genesis */ }
  const blob = g(gd, ["hash-object", "-w", "--stdin"], { input: canon(ev) });
  const idxDir = mkdtempSync(join(tmpdir(), "kiln-sign-forge-"));
  const ienv = { ...GIT_ENV, GIT_INDEX_FILE: join(idxDir, "index") };
  if (tip) execFileSync("git", ["--git-dir", gd, "read-tree", tip], { env: ienv });
  else execFileSync("git", ["--git-dir", gd, "read-tree", "--empty"], { env: ienv });
  const name = `events/${String(ev.seq).padStart(8, "0")}-${ev.id}.json`;
  execFileSync("git", ["--git-dir", gd, "update-index", "--add", "--cacheinfo", `100644,${blob},${name}`], { env: ienv });
  const tree = execFileSync("git", ["--git-dir", gd, "write-tree"], { encoding: "utf8", env: ienv }).trim();
  const args = ["commit-tree", tree, "-m", `memory: ${ev.type} ${ev.id}`];
  if (tip) args.push("-p", tip);
  const commit = execFileSync("git", ["--git-dir", gd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
  execFileSync("git", ["--git-dir", gd, "update-ref", MEMORY_REF, commit, tip || "0".repeat(40)], { env: GIT_ENV });
  return commit;
}

/** A well-formed UNSIGNED episode, hash-chained correctly (pre-phase-2 shape). */
function legacyEvent(seq, prev, content) {
  const ev = {
    v: 1, id: `mem_legacy${seq}`, seq, prev, type: "episode",
    ts: 1760000000 + seq, actor: "old-writer", kind: "note", title: "",
    content, tags: [], entities: [], eventDate: null, source: null, salience: 1,
  };
  ev.hash = computeEventHash(ev);
  return ev;
}

describe("memory signing: writers sign, key stays out of git", () => {
  it("signs every event type; pubkey surface agrees; key file is 0600", () => {
    const dir = freshRepo();
    assert.equal(memorySigningPubkey(dir), null); // reads never create the key

    const ep = remember(dir, ...R, { content: "signed episode about falcons", actor: "test" }).event;
    const fact = assertFact(dir, ...R, {
      subject: "falcon", predicate: "is", object: "fast", sourceEpisodes: [ep.id], actor: "test",
    }).event;
    const link = linkMemories(dir, ...R, { from: ep.id, to: fact.id, relation: "supports", actor: "test" }).event;
    const core = setCore(dir, ...R, { label: "project", value: "signed core", actor: "test" }).event;
    const prop = proposeMemory(dir, ...R, {
      kind: "fact",
      payload: { subject: "falcon", predicate: "eats", object: "pigeons", sourceEpisodes: [ep.id] },
      actor: "test",
    }).event;
    const resolved = resolveProposal(dir, ...R, { proposal: prop.id, decision: "ratified", actor: "test" });

    const { events } = readEvents(dir, ...R);
    assert.equal(events.length, 7); // ep, fact, link, core, proposal, materialized fact, status
    for (const ev of events) {
      assert.equal(typeof ev.sig, "string", `${ev.type} ${ev.id} must be signed`);
      assert.equal(ev.sig.length, 128, "ed25519 signature is 64 bytes hex");
      assert.equal(verifyEventSignature(ev), true, `${ev.id} must verify standalone`);
    }
    assert.equal(resolved.materialized.sig.length, 128);
    assert.equal(resolved.statusEvent.sig.length, 128);

    const keyPath = memorySigningKeyPath(dir);
    assert.ok(existsSync(keyPath), "key file must exist after the first write");
    assert.equal(statSync(keyPath).mode & 0o777, 0o600, "key file must be 0600");

    const pub = memorySigningPubkey(dir);
    assert.equal(pub.signer, ep.signer);
    assert.equal(pub.pubSpkiB64, ep.signerKey);

    // The private key is nowhere in the repo: scan every object in the bare repo.
    const gd = repoPath(dir, ...R);
    const all = g(gd, ["cat-file", "--batch-all-objects", "--batch"], {});
    assert.ok(!all.includes("PRIVATE KEY"), "no key material in git objects");
    assert.ok(!all.includes("privPkcs8B64"), "no stored-key JSON in git objects");

    const v = verifyMemory(dir, ...R);
    assert.equal(v.ok, true);
    assert.deepEqual(v.signatures, { signed: 7, legacy: 0, epochStart: 0, signers: [ep.signer] });
    const stats = memoryStats(dir, ...R);
    assert.equal(stats.signing.currentSigner, ep.signer);
    assert.equal(stats.signing.signed, 7);
  });

  it("unit round-trip: tampering with sig, hash, or signerKey breaks verification", () => {
    const dir = freshRepo();
    const ev = remember(dir, ...R, { content: "round trip", actor: "test" }).event;
    assert.equal(verifyEventSignature(ev), true);
    const flip = (s) => (s[0] === "0" ? "1" : "0") + s.slice(1);
    assert.equal(verifyEventSignature({ ...ev, sig: flip(ev.sig) }), false, "altered signature");
    assert.equal(verifyEventSignature({ ...ev, hash: flip(ev.hash) }), false, "signature is over the hash");
    const other = newKeypair();
    assert.equal(
      verifyEventSignature({ ...ev, signerKey: other.pubSpkiB64 }), false,
      "a different key must fail the signer binding");
    assert.equal(
      verifyEventSignature({ ...ev, signer: other.id, signerKey: other.pubSpkiB64 }), false,
      "a fully swapped signer identity still fails: the signature is the original key's");
    assert.equal(verifyEventSignature({ ...ev, sig: undefined }), false, "unsigned is not verified");
  });

  it("refuses to load a group/world-readable signing key", () => {
    const dir = makeStateDir();
    const kp = newKeypair();
    const path = memorySigningKeyPath(dir);
    writeFileSync(path, JSON.stringify({ v: 1, pubSpkiB64: kp.pubSpkiB64, privPkcs8B64: kp.privPkcs8B64 }) + "\n");
    chmodSync(path, 0o644);
    assert.throws(() => loadOrCreateMemoryKey(dir), /must be mode 0600/);
  });
});

describe("memory signing: tamper detection", () => {
  it("rejects an event whose body was altered and hash recomputed (stale signature)", () => {
    const dir = freshRepo();
    const ep = remember(dir, ...R, { content: "the launch is on Friday", actor: "test" }).event;
    // Forge: same signer identity, altered content, CORRECTLY recomputed
    // hash and chain link — only the signature is stale. Hash-chain
    // checks alone would pass this; the signature must catch it.
    const forged = { ...ep, id: "mem_forged1", seq: 1, prev: ep.hash, content: "the launch is cancelled" };
    delete forged.hash; delete forged.sig;
    forged.hash = computeEventHash(forged);
    forged.sig = ep.sig; // signature over the ORIGINAL event's hash
    appendRawEvent(dir, ...R, forged);
    assert.throws(() => readEvents(dir, ...R), /signature verification failed/);
    const v = verifyMemory(dir, ...R);
    assert.equal(v.ok, false);
    assert.match(v.error, /signature verification failed/);
  });

  it("rejects an unsigned event appended after the signing epoch opened", () => {
    const dir = freshRepo();
    const ep = remember(dir, ...R, { content: "epoch opener", actor: "test" }).event;
    const unsigned = legacyEvent(1, ep.hash, "sneaked in unsigned");
    appendRawEvent(dir, ...R, unsigned);
    assert.throws(() => readEvents(dir, ...R), /no signature but the signing epoch opened at seq 0/);
    assert.equal(verifyMemory(dir, ...R).ok, false);
  });
});

describe("memory signing: the legacy boundary", () => {
  it("a pre-phase-2 unsigned chain stays readable; the epoch opens at the first signed write", () => {
    const dir = freshRepo();
    const e0 = legacyEvent(0, "GENESIS", "legacy note about the old roadmap");
    appendRawEvent(dir, ...R, e0);
    const e1 = legacyEvent(1, e0.hash, "another legacy note");
    appendRawEvent(dir, ...R, e1);

    const state = loadMemory(dir, ...R);
    assert.equal(state.episodes.length, 2);
    const rec = recall(dir, ...R, "legacy roadmap");
    assert.ok(rec.results.some((x) => x.id === e0.id), "legacy episodes remain recallable");
    const v = verifyMemory(dir, ...R);
    assert.equal(v.ok, true);
    assert.deepEqual(v.signatures, { signed: 0, legacy: 2, epochStart: null, signers: [] });

    // First library write on the legacy chain: signed, epoch opens at seq 2.
    const ep = remember(dir, ...R, { content: "first signed note", actor: "test" }).event;
    assert.equal(ep.seq, 2);
    assert.ok(ep.sig);
    const v2 = verifyMemory(dir, ...R);
    assert.equal(v2.ok, true);
    assert.deepEqual(v2.signatures, { signed: 1, legacy: 2, epochStart: 2, signers: [ep.signer] });
    const summary = verifyEventChain(readEvents(dir, ...R).events);
    assert.equal(summary.epochStart, 2);
  });
});

describe("memory signing: promote replay path", () => {
  it("lists a signed chain, then refuses the same chain after a sig-tampered append", async () => {
    const dir = freshRepo();
    const ep = remember(dir, ...R, { content: "replay me honestly", actor: "test" }).event;
    assertFact(dir, ...R, {
      subject: "replay", predicate: "is", object: "signed", sourceEpisodes: [ep.id], actor: "test",
    });
    const gd = repoPath(dir, ...R);
    const commits = await listMemoryCommits(gd);
    assert.equal(commits.length, 2);

    const { events } = readEvents(dir, ...R);
    const tipEv = events[events.length - 1];
    const forged = { ...tipEv, id: "mem_forged2", seq: 2, prev: tipEv.hash, object: "forged" };
    delete forged.hash; delete forged.sig;
    forged.hash = computeEventHash(forged);
    forged.sig = tipEv.sig;
    appendRawEvent(dir, ...R, forged);
    await assert.rejects(() => listMemoryCommits(gd), /failed verification: memory: signature verification failed/);
  });

  it("lists a legacy unsigned chain without complaint", async () => {
    const dir = freshRepo();
    const e0 = legacyEvent(0, "GENESIS", "legacy replay source");
    appendRawEvent(dir, ...R, e0);
    const commits = await listMemoryCommits(repoPath(dir, ...R));
    assert.equal(commits.length, 1);
    assert.equal(commits[0].id, e0.id);
  });
});

describe("memory signing: CLI discovery surface", () => {
  it("`memory pubkey` prints the signer that the events carry", () => {
    const dir = freshRepo();
    const ep = remember(dir, ...R, { content: "cli surface", actor: "test" }).event;
    const r = spawnSync(process.execPath, [SWARM, "memory", "pubkey", "--repo", "auro/sigtest", "--dir", dir], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.signer, ep.signer);
    assert.equal(out.pubSpkiB64, ep.signerKey);
    assert.equal(out.signatures.signed, 1);
    assert.ok(!("privPkcs8B64" in out), "the CLI never prints private key material");
  });
});
