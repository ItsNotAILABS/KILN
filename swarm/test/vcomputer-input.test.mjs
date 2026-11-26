/**
 * Control-API input mapping (pure): actions -> xdotool argv, coordinate
 * rules (pixels or SCREEN-KERNEL 0..1), and that typed text travels on
 * stdin — never argv, where /proc and logs could see it. Also spec
 * validation for create.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inputToXdotool, normalizeSpec, DEFAULTS, VcError } from "../lib/vcomputer.mjs";

const SIZE = { width: 1280, height: 800 };
const st = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof VcError, e.message); return e.status; } return 0; };

test("move/click: pixel and normalized coordinates", () => {
  assert.deepEqual(inputToXdotool({ action: "move", x: 10, y: 20 }, SIZE).argv, ["xdotool", "mousemove", "10", "20"]);
  assert.deepEqual(inputToXdotool({ action: "move", nx: 1, ny: 0 }, SIZE).argv, ["xdotool", "mousemove", "1279", "0"]);
  assert.deepEqual(inputToXdotool({ action: "move", nx: 0.5, ny: 0.5 }, SIZE).argv, ["xdotool", "mousemove", "640", "400"]);
  assert.deepEqual(
    inputToXdotool({ action: "click", x: 5, y: 6, button: "right", count: 2 }, SIZE).argv,
    ["xdotool", "mousemove", "5", "6", "click", "--repeat", "2", "--delay", "80", "3"]);
  // click without a point clicks where the pointer is
  assert.deepEqual(inputToXdotool({ action: "click" }, SIZE).argv, ["xdotool", "click", "--repeat", "1", "--delay", "80", "1"]);
});

test("coordinates outside the screen are refused, not clamped", () => {
  assert.equal(st(() => inputToXdotool({ action: "move", x: 1280, y: 0 }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool({ action: "move", x: -1, y: 0 }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool({ action: "move", x: 1.5, y: 0 }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool({ action: "move", nx: 1.01, ny: 0 }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool({ action: "move", x: 3 }, SIZE)), 400, "x without y");
  assert.equal(st(() => inputToXdotool({ action: "move" }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool({ action: "click", button: "back" }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool({ action: "click", count: 9 }, SIZE)), 400);
});

test("type: text goes on stdin only", () => {
  const secret = "hunter2-🔑-$(rm -rf /)";
  const p = inputToXdotool({ action: "type", text: secret }, SIZE);
  assert.equal(p.argv, null);
  assert.deepEqual(p.typeArgv, ["xdotool", "type", "--delay", "12", "--file", "-"]);
  assert.equal(p.stdin, secret);
  assert.ok(!JSON.stringify([p.argv, p.typeArgv]).includes("hunter2"));
  const withClick = inputToXdotool({ action: "type", text: "a", x: 1, y: 2 }, SIZE);
  assert.deepEqual(withClick.argv, ["xdotool", "mousemove", "1", "2", "click", "1"]);
  assert.equal(st(() => inputToXdotool({ action: "type", text: "" }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool({ action: "type", text: "x".repeat(10001) }, SIZE)), 400);
});

test("key: keysym combos only (no option injection)", () => {
  assert.deepEqual(inputToXdotool({ action: "key", keys: "ctrl+l" }, SIZE).argv,
    ["xdotool", "key", "--delay", "40", "--", "ctrl+l"]);
  assert.deepEqual(inputToXdotool({ action: "key", keys: ["ctrl+shift+t", "Return"] }, SIZE).argv.slice(-2), ["ctrl+shift+t", "Return"]);
  assert.equal(st(() => inputToXdotool({ action: "key", keys: "--window 1" }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool({ action: "key", keys: "ctrl+;" }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool({ action: "key", keys: [] }, SIZE)), 400);
});

test("scroll and drag", () => {
  assert.deepEqual(inputToXdotool({ action: "scroll", dy: 3 }, SIZE).argv,
    ["xdotool", "click", "--repeat", "3", "--delay", "30", "5"]);
  assert.deepEqual(inputToXdotool({ action: "scroll", x: 1, y: 1, dy: -2, dx: 1 }, SIZE).argv,
    ["xdotool", "mousemove", "1", "1", "click", "--repeat", "2", "--delay", "30", "4", "click", "--repeat", "1", "--delay", "30", "7"]);
  assert.equal(st(() => inputToXdotool({ action: "scroll" }, SIZE)), 400);
  assert.deepEqual(inputToXdotool({ action: "drag", x: 1, y: 2, x2: 30, y2: 40 }, SIZE).argv,
    ["xdotool", "mousemove", "1", "2", "mousedown", "1", "sleep", "0.1", "mousemove", "30", "40", "sleep", "0.1", "mouseup", "1"]);
  assert.equal(st(() => inputToXdotool({ action: "drag", x: 1, y: 2 }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool({ action: "teleport" }, SIZE)), 400);
  assert.equal(st(() => inputToXdotool(null, SIZE)), 400);
});

test("normalizeSpec: defaults and limits", () => {
  const s = normalizeSpec({ name: "agent-1", backend: "local" });
  assert.equal(s.backend, "local");
  assert.deepEqual(s.config, {
    width: DEFAULTS.width, height: DEFAULTS.height, cpus: DEFAULTS.cpus, memoryMB: DEFAULTS.memoryMB,
    diskMB: DEFAULTS.diskMB, idleTimeoutSec: DEFAULTS.idleTimeoutSec, pidsLimit: DEFAULTS.pidsLimit,
    browser: true, network: true,
  });
  assert.equal(normalizeSpec({ name: "a", backend: "docker", cpus: 0.5 }).config.cpus, 0.5);
  for (const bad of [
    { name: "Bad Name" }, { name: "" }, { name: "-x" }, { name: "a".repeat(41) },
    { name: "a", backend: "vmware" }, { name: "a", width: 100 }, { name: "a", memoryMB: 10 },
    { name: "a", cpus: 64 }, { name: "a", browser: "yes" }, { name: "a", idleTimeoutSec: -1 },
  ]) {
    assert.equal(st(() => normalizeSpec({ backend: "local", ...bad })), 400, JSON.stringify(bad));
  }
});
