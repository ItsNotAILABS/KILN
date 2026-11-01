/**
 * Discovery drift pin.
 *
 * The architect's discovery audit found the served OpenAPI document
 * covering ~12 paths while the daemon registered ~35 forge/package
 * routes, and the capabilities index drifting the other way (sites
 * create/delete existed in code, unlisted). This test is the fence:
 *
 *   1. EXPECTED below is the canonical table of every (method, path)
 *      the daemon serves under /v1, taken from lib/httpapi.mjs.
 *   2. Every EXPECTED route must appear as an operation in
 *      buildOpenApiDocument() AND as an endpoint in
 *      buildCapabilities() — and neither document may carry an
 *      operation/endpoint that is not in EXPECTED (no phantom docs).
 *   3. A scan of lib/httpapi.mjs extracts every /v1 route fragment the
 *      router actually matches (path === literals, startsWith
 *      prefixes, and the route regexes, which all live on one line).
 *      Each fragment must be covered by an EXPECTED template — so
 *      registering a new /v1 PATH without updating the documents and
 *      this table fails here, loudly.
 *
 * Honest limit: the scan pins paths, not methods — a new METHOD on an
 * existing path is caught only by updating EXPECTED (which a failure
 * in checks 1–2 then enforces against both documents).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCapabilities, buildOpenApiDocument } from "../lib/openapi.mjs";

const EXPECTED = [
  // accounts + agent identities
  ["POST", "/v1/accounts"],
  ["POST", "/v1/accounts/login"],
  ["GET", "/v1/accounts/me"],
  ["POST", "/v1/accounts/me/agents"],
  ["GET", "/v1/accounts/me/agents"],
  ["DELETE", "/v1/accounts/me/agents/{id}"],
  // wallet identity binding + encrypted backup
  ["POST", "/v1/accounts/me/wallets/challenge"],
  ["POST", "/v1/accounts/me/wallets"],
  ["GET", "/v1/accounts/me/wallets"],
  ["DELETE", "/v1/accounts/me/wallets/{address}"],
  ["PUT", "/v1/accounts/me/wallet-backup"],
  ["GET", "/v1/accounts/me/wallet-backup"],
  // encrypted email binding
  ["PUT", "/v1/accounts/me/email"],
  // repo lifecycle + project details
  ["POST", "/v1/repos"],
  ["DELETE", "/v1/repos/{owner}/{repo}"],
  // creation templates (per-account)
  ["POST", "/v1/templates"],
  ["GET", "/v1/templates"],
  ["GET", "/v1/templates/{id}"],
  ["DELETE", "/v1/templates/{id}"],
  ["GET", "/v1/repos/{owner}/{repo}/details"],
  ["PATCH", "/v1/repos/{owner}/{repo}/details"],
  // forge
  ["GET", "/v1/repos/{owner}/{repo}/branches"],
  ["POST", "/v1/repos/{owner}/{repo}/branches"],
  ["DELETE", "/v1/repos/{owner}/{repo}/branches/{name}"],
  ["GET", "/v1/repos/{owner}/{repo}/tree"],
  ["GET", "/v1/repos/{owner}/{repo}/contents"],
  ["PUT", "/v1/repos/{owner}/{repo}/contents"],
  ["DELETE", "/v1/repos/{owner}/{repo}/contents"],
  ["GET", "/v1/repos/{owner}/{repo}/commits"],
  ["GET", "/v1/repos/{owner}/{repo}/commits/{sha}"],
  ["GET", "/v1/repos/{owner}/{repo}/compare"],
  ["GET", "/v1/repos/{owner}/{repo}/tags"],
  ["GET", "/v1/repos/{owner}/{repo}/releases"],
  ["POST", "/v1/repos/{owner}/{repo}/releases"],
  ["GET", "/v1/repos/{owner}/{repo}/releases/{tag}"],
  ["PATCH", "/v1/repos/{owner}/{repo}/releases/{tag}"],
  ["DELETE", "/v1/repos/{owner}/{repo}/releases/{tag}"],
  ["GET", "/v1/repos/{owner}/{repo}/pulls"],
  ["POST", "/v1/repos/{owner}/{repo}/pulls"],
  ["GET", "/v1/repos/{owner}/{repo}/pulls/{n}"],
  ["PATCH", "/v1/repos/{owner}/{repo}/pulls/{n}"],
  ["POST", "/v1/repos/{owner}/{repo}/pulls/{n}/comments"],
  ["POST", "/v1/repos/{owner}/{repo}/pulls/{n}/reviews"],
  ["POST", "/v1/repos/{owner}/{repo}/pulls/{n}/merge"],
  // packages
  ["GET", "/v1/packages"],
  ["GET", "/v1/packages/{owner}/{name}"],
  ["GET", "/v1/packages/{owner}/{name}/{version}"],
  ["GET", "/v1/packages/{owner}/{name}/{version}/{filename}"],
  ["PUT", "/v1/packages/{owner}/{name}/{version}/{filename}"],
  // workspaces
  ["POST", "/v1/workspaces"],
  ["GET", "/v1/workspaces"],
  ["GET", "/v1/workspaces/{id}"],
  ["PATCH", "/v1/workspaces/{id}"],
  ["DELETE", "/v1/workspaces/{id}"],
  // workspace invites by email + acceptance
  ["POST", "/v1/workspaces/{id}/invites"],
  ["GET", "/v1/workspaces/{id}/invites"],
  ["DELETE", "/v1/workspaces/{id}/invites/{inviteId}"],
  ["POST", "/v1/invites/{token}/accept"],
  // mail outbox
  ["GET", "/v1/mail/outbox"],
  ["POST", "/v1/mail/send"],
  // sites
  ["POST", "/v1/sites"],
  ["GET", "/v1/sites"],
  ["GET", "/v1/sites/{id}"],
  ["DELETE", "/v1/sites/{id}"],
  // compute
  ["POST", "/v1/compute/invoke"],
  ["GET", "/v1/compute/invocations/{id}"],
  ["POST", "/v1/compute/map"],
  ["GET", "/v1/compute/map/{id}"],
  ["GET", "/v1/compute/capacity"],
  ["POST", "/v1/compute/apps"],
  ["GET", "/v1/compute/apps"],
  ["GET", "/v1/compute/apps/{id}"],
  ["DELETE", "/v1/compute/apps/{id}"],
  ["GET", "/v1/compute/apps/{id}/logs"],
  ["POST", "/v1/compute/apps/{id}/preview"],
  ["DELETE", "/v1/compute/apps/{id}/preview"],
  // promote
  ["POST", "/v1/promote"],
  // discovery (served by the documents themselves)
  ["GET", "/v1/capabilities"],
  ["GET", "/v1/openapi.json"],
];

const METHODS = ["get", "post", "put", "patch", "delete"];

/** "{owner}" / ":owner" / "{id}" path params all normalize to "{}". */
function normTemplate(t) {
  return t
    .split("?")[0]
    .replace(/\{[^}]*\}/g, "{}")
    .replace(/:[A-Za-z0-9_]+/g, "{}")
    .replace(/\/+$/, "");
}

function segs(t) {
  return normTemplate(t).split("/").filter(Boolean);
}

/** Segment-wise prefix compatibility in either direction; "**" eats any suffix. */
function covers(fSegs, tSegs) {
  const n = Math.min(fSegs.length, tSegs.length);
  for (let i = 0; i < n; i++) {
    if (fSegs[i] === "**") return true;
    if (fSegs[i] !== tSegs[i]) return false;
  }
  return true;
}

test("openapi + capabilities cover exactly the registered /v1 routes", () => {
  const doc = buildOpenApiDocument();
  const expectedKeys = new Set(EXPECTED.map(([m, t]) => `${m} ${t}`));

  // 1. Every expected route is an OpenAPI operation — and no extras.
  const docOps = [];
  for (const [pathTpl, ops] of Object.entries(doc.paths)) {
    for (const k of Object.keys(ops)) {
      if (METHODS.includes(k)) docOps.push(`${k.toUpperCase()} ${pathTpl}`);
    }
  }
  for (const key of expectedKeys) {
    assert.ok(docOps.includes(key), `OpenAPI document is missing ${key} — document the route in lib/openapi.mjs`);
  }
  for (const op of docOps) {
    assert.ok(expectedKeys.has(op), `OpenAPI documents ${op}, which is not a registered route — remove it or register the route`);
  }

  // 2. Every expected route is a capabilities endpoint — and no extras.
  //    The two discovery routes are the documents themselves: capabilities
  //    is served AT /v1/capabilities and points at the spec via .openapi.
  const caps = buildCapabilities();
  assert.equal(caps.openapi, "/v1/openapi.json");
  const capSet = new Set(["GET /v1/capabilities", "GET /v1/openapi.json"]);
  for (const ability of caps.abilities) {
    for (const e of ability.endpoints) {
      const sp = e.indexOf(" ");
      capSet.add(`${e.slice(0, sp)} ${normTemplate(e.slice(sp + 1))}`);
    }
  }
  for (const [m, t] of EXPECTED) {
    assert.ok(capSet.has(`${m} ${normTemplate(t)}`), `capabilities index is missing ${m} ${t} — list it in buildCapabilities()`);
  }
  const expectedNorm = new Set(EXPECTED.map(([m, t]) => `${m} ${normTemplate(t)}`));
  for (const entry of capSet) {
    assert.ok(expectedNorm.has(entry), `capabilities lists ${entry}, which is not a registered route`);
  }
});

test("every /v1 route fragment in httpapi.mjs is covered by the expected table", () => {
  const src = readFileSync(new URL("../lib/httpapi.mjs", import.meta.url), "utf8");
  const expectedSegs = EXPECTED.map(([, t]) => segs(t));
  const fragments = new Set();

  // (a) quoted literals that START with /v1/ (path === checks, startsWith
  //     prefixes). Prose strings mentioning a route mid-sentence don't
  //     start with it and are not route registrations.
  for (const m of src.matchAll(/["'`](\/v1\/[^"'`\\]*)["'`]/g)) {
    fragments.add(m[1]);
  }
  // (b) route regexes — all on single lines, anchored /^\/v1 ... $/.
  for (const line of src.split("\n")) {
    for (const m of line.matchAll(/\/\^\\\/v1((?:\\.|[^/])*?)\$\//g)) {
      for (const tpl of regexToTemplates(m[0])) fragments.add(tpl);
    }
  }

  assert.ok(fragments.size >= 20, `route scan found only ${fragments.size} fragments — the scan itself is broken`);
  for (const f of fragments) {
    const fSegs = segs(f);
    assert.ok(
      expectedSegs.some((tSegs) => covers(fSegs, tSegs)),
      `httpapi.mjs registers route fragment "${f}", which no documented route covers — ` +
      "add the route to EXPECTED (test/openapi-drift.test.mjs) and document it in lib/openapi.mjs"
    );
  }
});

// ---------------------------------------------------------- regex expansion

/** Expand one route-regex source into the path templates it can match. */
function regexToTemplates(reSrc) {
  let s = reSrc.replace(/^\/\^/, "").replace(/\$\/$/, "");
  s = s.replace(/\\\//g, "/");
  return expandGroups(s).map(leafNorm);
}

function expandGroups(s) {
  const i = s.indexOf("(");
  if (i < 0) return [s];
  let depth = 0, j = i;
  for (; j < s.length; j++) {
    if (s[j] === "\\") { j++; continue; }
    if (s[j] === "(") depth++;
    else if (s[j] === ")") { depth--; if (depth === 0) break; }
  }
  if (j >= s.length) return [s]; // unbalanced — treat as leaf
  const inner = s.slice(i + 1, j);
  const optional = s[j + 1] === "?";
  const before = s.slice(0, i);
  const after = s.slice(j + (optional ? 2 : 1));

  let variants;
  if (inner.startsWith("?:")) variants = expandGroups(inner.slice(2));
  else if (/^[A-Za-z0-9_]+(\|[A-Za-z0-9_]+)+$/.test(inner)) variants = inner.split("|");
  else if (inner.includes("/")) variants = expandGroups(inner);
  else if (inner === ".*") variants = ["**"];
  else variants = ["{}"]; // any single-segment pattern group

  const out = [];
  for (const v of variants) out.push(...expandGroups(before + v + after));
  if (optional) out.push(...expandGroups(before + after));
  return [...new Set(out)].slice(0, 64);
}

function leafNorm(s) {
  // A leftover ".*" (from a (\/*)? rest group) marks "any suffix".
  return s.split("/").map((seg) => {
    if (seg === ".*" || seg === "**") return "**";
    if (/[[\]{}+*]/.test(seg)) return "{}";
    return seg;
  }).join("/");
}
