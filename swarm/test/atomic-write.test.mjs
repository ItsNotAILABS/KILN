/**
 * Atomic state-write tests — the 0-byte wedge family.
 *
 * On 2026-10-23 a host write fault zeroed nodes/<wing-research>/node.json
 * because saveNode wrote in place (writeFileSync truncates, then writes).
 * Every swarm/doctor state writer now goes through a tmp+fsync+rename
 * helper. These tests prove the invariant the hard way: simulate the
 * fault mid-save and at the rename boundary, and require the previous
 * complete file to survive byte-intact.
 *
 * Fault simulation uses the TEST-ONLY env hooks (never set in
 * production): KILN_ATOMIC_WRITE_FAULT for lib/state.mjs's
 * writeFileAtomicSync, DOCTOR_ATOMIC_WRITE_FAULT for doctor-core's
 * atomicWriteSync.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import {
  writeFileAtomicSync, saveNode, loadNode, writeKeyFile, loadKeyFile, nodeJsonPath,
} from "../lib/state.mjs";
import {
  atomicWriteSync, writeDoctorState, readDoctorState, doctorStatePath, ensureDoctorDir,
} from "../lib/doctor-core/helpers.mjs";

const FAULT_ENVS = ["KILN_ATOMIC_WRITE_FAULT", "DOCTOR_ATOMIC_WRITE_FAULT"];
afterEach(() => { for (const k of FAULT_ENVS) delete process.env[k]; });

function tmpLeftovers(dir) {
  return readdirSync(dir).filter((n) => n.includes(".tmp-"));
}

describe("writeFileAtomicSync", () => {
  it("writes exact content, replaces fully on rewrite, leaves no tmp files", () => {
    const dir = makeStateDir();
    const p = join(dir, "state.json");
    writeFileAtomicSync(p, '{"v":1}\n');
    assert.equal(readFileSync(p, "utf8"), '{"v":1}\n');
    writeFileAtomicSync(p, '{"v":2,"longer":"payload"}\n');
    assert.equal(readFileSync(p, "utf8"), '{"v":2,"longer":"payload"}\n');
    assert.deepEqual(tmpLeftovers(dir), []);
  });

  it("fault mid-save (KILN_ATOMIC_WRITE_FAULT): throws and the prior file is byte-intact", () => {
    const dir = makeStateDir();
    const p = join(dir, "state.json");
    const v1 = '{"version":1,"fence":"keep-me-exactly"}\n';
    writeFileAtomicSync(p, v1);
    process.env.KILN_ATOMIC_WRITE_FAULT = "1";
    assert.throws(() => writeFileAtomicSync(p, '{"version":2,"fence":"torn"}\n'), /simulated host write fault/);
    assert.equal(readFileSync(p, "utf8"), v1, "target must survive a faulted save byte-intact");
    assert.deepEqual(tmpLeftovers(dir), [], "faulted tmp file must be cleaned up");
  });

  it("fault at the rename boundary: target obstructed by a directory — nothing is mutated", () => {
    const dir = makeStateDir();
    const p = join(dir, "blocked.json");
    // A non-empty directory where the target file should land makes
    // rename(2) fail AFTER the tmp payload is fully written + fsynced:
    // the fault lands exactly on the rename boundary.
    mkdirSync(p);
    writeFileSync(join(p, "occupant.txt"), "do not touch\n");
    assert.throws(() => writeFileAtomicSync(p, '{"x":1}\n'));
    assert.equal(readFileSync(join(p, "occupant.txt"), "utf8"), "do not touch\n");
    assert.deepEqual(tmpLeftovers(dir), [], "tmp must be cleaned up after a failed rename");
  });

  it("honors mode exactly (0600 key files survive umask)", () => {
    const dir = makeStateDir();
    const p = join(dir, "key.json");
    writeFileAtomicSync(p, '{"secret":true}\n', { mode: 0o600 });
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });
});

describe("swarm state writers under fault", () => {
  it("saveNode: a faulted save leaves the previous node.json byte-intact", () => {
    const dir = makeStateDir();
    const rec = { id: "node-fault-test", name: "faulty", restarts: 0 };
    mkdirSync(join(dir, "nodes", rec.id), { recursive: true }); // createNode does this in real life
    saveNode(dir, rec);
    const before = readFileSync(nodeJsonPath(dir, rec.id), "utf8");
    process.env.KILN_ATOMIC_WRITE_FAULT = "1";
    assert.throws(() => saveNode(dir, { ...rec, restarts: 99 }), /simulated host write fault/);
    delete process.env.KILN_ATOMIC_WRITE_FAULT;
    assert.equal(readFileSync(nodeJsonPath(dir, rec.id), "utf8"), before);
    assert.equal(loadNode(dir, rec.id).restarts, 0, "the torn save must never become visible");
    assert.deepEqual(tmpLeftovers(join(dir, "nodes", rec.id)), []);
  });

  it("writeKeyFile round-trips and stays 0600", () => {
    const dir = makeStateDir();
    const id = "node-key-test";
    mkdirSync(join(dir, "nodes", id), { recursive: true });
    writeKeyFile(dir, id, { privPkcs8B64: "AA==", pubSpkiB64: "BB==" });
    assert.deepEqual(loadKeyFile(dir, id), { privPkcs8B64: "AA==", pubSpkiB64: "BB==" });
    assert.equal(statSync(join(dir, "nodes", id, "key.json")).mode & 0o777, 0o600);
  });
});

describe("doctor-core atomic writes", () => {
  it("atomicWriteSync: fault mid-save leaves the prior file byte-intact", () => {
    const dir = makeStateDir();
    const p = join(dir, "state.json");
    atomicWriteSync(p, '{"fence":1}\n');
    process.env.DOCTOR_ATOMIC_WRITE_FAULT = "1";
    assert.throws(() => atomicWriteSync(p, '{"fence":2}\n'), /simulated host write fault/);
    assert.equal(readFileSync(p, "utf8"), '{"fence":1}\n');
    assert.deepEqual(tmpLeftovers(dir), []);
  });

  it("writeDoctorState: even a swallowed fault keeps the previous complete state readable", () => {
    const dir = makeStateDir();
    ensureDoctorDir(dir);
    writeDoctorState(dir, { expectedBootId: "boot-1", recoveryExhausted: false });
    const before = readFileSync(doctorStatePath(dir), "utf8");
    process.env.DOCTOR_ATOMIC_WRITE_FAULT = "1";
    writeDoctorState(dir, { expectedBootId: "boot-2", recoveryExhausted: true }); // must not throw (best effort)
    delete process.env.DOCTOR_ATOMIC_WRITE_FAULT;
    assert.equal(readFileSync(doctorStatePath(dir), "utf8"), before, "torn state must never replace the fence");
    assert.equal(readDoctorState(dir).expectedBootId, "boot-1");
    assert.ok(existsSync(doctorStatePath(dir)));
  });
});
