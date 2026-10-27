/**
 * KILN MCP server: stock-client proof.
 *
 * No insider helpers: this test spawns `node swarm/mcp-server.mjs` as a
 * child process and speaks RAW JSON-RPC 2.0 (newline-delimited JSON,
 * MCP 2024-11-05) over its stdio — initialize handshake,
 * notifications/initialized, tools/list, tools/call — exactly like any
 * generic MCP client would. The server is pointed (KILN_SWARM_DIR) at a
 * temp state dir whose daemon.json + api.token describe a REAL
 * ephemeral API server (lib/httpapi.mjs) backed by REAL hosted repos
 * with REAL commits (seeded the same way test/workspaces.test.mjs
 * seeds them). Nothing is mocked.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeStateDir } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import { startApiServer } from "../lib/httpapi.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(HERE, "..", "mcp-server.mjs");
// Throwaway token for the temp state dir ONLY — never a real credential.
const TEST_TOKEN = "mcp-test-throwaway-token";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Push one real commit into an already-created hosted repo. Returns the sha. */
function seedRepo(dir, owner, repo, subject) {
  createRepo(dir, owner, repo);
  const bare = repoPath(dir, owner, repo);
  const work = mkdtempSync(join(tmpdir(), "kiln-mcp-seed-"));
  try {
    git(work, ["init", "-q", "-b", "main"]);
    git(work, ["config", "user.email", "test@kiln.local"]);
    git(work, ["config", "user.name", "kiln-test"]);
    writeFileSync(join(work, "README.md"), `# ${repo}\n\n${subject}\n`);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", subject]);
    git(work, ["push", "-q", bare, "main"]);
    return git(work, ["rev-parse", "HEAD"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Minimal raw JSON-RPC client over a child process's stdio: writes one
 * JSON object per line, resolves replies by id. This is deliberately
 * written from the MCP/JSON-RPC specs, not from the server's source.
 */
class StdioRpcClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.nullWaiters = []; // resolvers for replies with id: null (parse errors)
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === null || msg.id === undefined) {
          const w = this.nullWaiters.shift();
          if (w) w(msg);
          continue;
        }
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { this.stderr += chunk; });
  }

  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request ${method} (id ${id}) timed out. Server stderr: ${this.stderr.slice(-500)}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** Send a raw line; resolves with the next id:null reply (parse errors). */
  sendRaw(line) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to raw line. Server stderr: ${this.stderr.slice(-500)}`)), 15000);
      this.nullWaiters.push((msg) => { clearTimeout(timer); resolve(msg); });
      this.child.stdin.write(line + "\n");
    });
  }

  /** tools/call helper: returns the MCP result object (not the envelope). */
  async callTool(name, args) {
    const res = await this.request("tools/call", { name, arguments: args });
    return res.result;
  }

  /** tools/call helper for the success path: parses the JSON text content. */
  async callToolJson(name, args) {
    const result = await this.callTool(name, args);
    assert.ok(result, `tool ${name}: no result`);
    assert.notEqual(result.isError, true, `tool ${name} errored: ${result.content?.[0]?.text}`);
    assert.equal(result.content[0].type, "text");
    return JSON.parse(result.content[0].text);
  }
}

describe("mcp server: stock JSON-RPC client over stdio", () => {
  let dir, api, child, rpc;
  let seedSha;

  before(async () => {
    dir = makeStateDir();
    // A real hosted repo with a real commit, for repo-details + membership.
    seedSha = seedRepo(dir, "auro", "mcp-seed", "mcp seed: initial commit");

    // Real ephemeral API server on this state dir. It loads its bearer
    // token from <dir>/api.token at startup, so write the throwaway
    // token FIRST (temp dir only), then start the server.
    writeFileSync(join(dir, "api.token"), TEST_TOKEN + "\n", { mode: 0o600 });
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    // daemon.json exactly as the real daemon writes it: where the API is.
    writeFileSync(
      join(dir, "daemon.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), apiUrl: api.url }) + "\n"
    );

    child = spawn(process.execPath, [MCP_SERVER], {
      env: { ...process.env, KILN_SWARM_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    rpc = new StdioRpcClient(child);
  });

  after(async () => {
    try { child?.stdin?.end(); } catch { /* already gone */ }
    try { child?.kill(); } catch { /* already gone */ }
    try { api?.server?.close(); } catch { /* already closed */ }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("answers the initialize handshake (MCP 2024-11-05) and ping", async () => {
    const res = await rpc.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "stock-test-client", version: "0" },
    });
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.result.protocolVersion, "2024-11-05");
    assert.deepEqual(res.result.capabilities, { tools: {} });
    assert.equal(res.result.serverInfo.name, "kiln-forge");
    assert.equal(typeof res.result.serverInfo.version, "string");

    // The initialized notification takes no reply; the following ping
    // proves the server kept processing after it.
    rpc.notify("notifications/initialized");
    const ping = await rpc.request("ping");
    assert.deepEqual(ping.result, {});
  });

  it("tools/list returns exactly the 7 workspace/details tools, each with a description and a strict input schema", async () => {
    const res = await rpc.request("tools/list");
    const tools = res.result.tools;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "kiln_repo_details",
        "kiln_workspace_create",
        "kiln_workspace_delete",
        "kiln_workspace_get",
        "kiln_workspace_list",
        "kiln_workspace_tree",
        "kiln_workspace_update",
      ]
    );
    for (const t of tools) {
      assert.equal(typeof t.description, "string");
      assert.ok(t.description.length > 40, `${t.name}: description too thin for an agent reader`);
      assert.equal(t.inputSchema.type, "object");
      assert.equal(typeof t.inputSchema.properties, "object");
    }
    const requiredOf = (name) => tools.find((t) => t.name === name).inputSchema.required || [];
    assert.deepEqual(requiredOf("kiln_workspace_create"), ["owner", "slug", "name"]);
    assert.deepEqual(requiredOf("kiln_workspace_get"), ["id"]);
    assert.deepEqual(requiredOf("kiln_workspace_update"), ["id"]);
    assert.deepEqual(requiredOf("kiln_workspace_delete"), ["id", "confirm"]);
    assert.deepEqual(requiredOf("kiln_repo_details"), ["owner", "repo"]);
    // setParent is how nesting changes on update — and it must accept null.
    const setParent = tools.find((t) => t.name === "kiln_workspace_update").inputSchema.properties.setParent;
    assert.ok(setParent.type.includes("string") && setParent.type.includes("null"));
    // The token must never leak into anything the server says.
    assert.ok(!JSON.stringify(res).includes(TEST_TOKEN));
  });

  it("creates a workspace via tools/call and lists it back", async () => {
    const created = await rpc.callToolJson("kiln_workspace_create", {
      owner: "auro", slug: "mcp-alpha", name: "MCP Alpha",
      description: "created by the stock MCP test client",
      repos: ["auro/mcp-seed"],
    });
    assert.equal(created.ok, true);
    assert.ok(created.workspace.id.startsWith("ws_"));
    assert.equal(created.workspace.slug, "mcp-alpha");
    assert.deepEqual(created.workspace.repos, ["auro/mcp-seed"]);

    const list = await rpc.callToolJson("kiln_workspace_list", { owner: "auro" });
    assert.equal(list.workspaces.length, 1);
    assert.equal(list.workspaces[0].id, created.workspace.id);

    const got = await rpc.callToolJson("kiln_workspace_get", { id: created.workspace.id });
    assert.equal(got.workspace.id, created.workspace.id);
    assert.equal(got.repos[0].repo, "auro/mcp-seed");
    assert.equal(got.repos[0].head.sha, seedSha);
  });

  it("kiln_repo_details returns live project details for a seeded repo", async () => {
    const details = await rpc.callToolJson("kiln_repo_details", { owner: "auro", repo: "mcp-seed" });
    assert.equal(details.repo, "auro/mcp-seed");
    assert.equal(typeof details.description, "string");
    assert.equal(details.commitCount, 1);
    assert.equal(details.lastCommit.sha, seedSha);
    assert.equal(details.lastCommit.subject, "mcp seed: initial commit");
  });

  it("nests a child under a parent with setParent, and the tree shows the nesting", async () => {
    const parent = await rpc.callToolJson("kiln_workspace_create", {
      owner: "auro", slug: "mcp-parent", name: "MCP Parent", repos: [],
    });
    const childWs = await rpc.callToolJson("kiln_workspace_create", {
      owner: "auro", slug: "mcp-child", name: "MCP Child", repos: [],
    });
    assert.equal(childWs.workspace.parentId ?? null, null);

    const updated = await rpc.callToolJson("kiln_workspace_update", {
      id: childWs.workspace.id, setParent: parent.workspace.id,
    });
    assert.equal(updated.workspace.parentId, parent.workspace.id);

    const tree = await rpc.callToolJson("kiln_workspace_tree", { owner: "auro" });
    const parentNode = tree.workspaces.find((w) => w.id === parent.workspace.id);
    assert.ok(parentNode, "parent must appear as a tree root");
    assert.deepEqual(parentNode.children.map((c) => c.id), [childWs.workspace.id]);
    const allRootIds = tree.workspaces.map((w) => w.id);
    assert.ok(!allRootIds.includes(childWs.workspace.id), "child must not also be a root");

    // Un-nest again with an explicit null (omit would mean "unchanged").
    const unnested = await rpc.callToolJson("kiln_workspace_update", {
      id: childWs.workspace.id, setParent: null,
    });
    assert.equal(unnested.workspace.parentId ?? null, null);
  });

  it("surfaces API errors verbatim as isError results (no stack, no wrapper)", async () => {
    const res = await rpc.request("tools/call", {
      name: "kiln_workspace_get", arguments: { id: "ws_nope" },
    });
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].type, "text");
    assert.equal(res.result.content[0].text, "no such workspace: ws_nope");
    assert.ok(!res.result.content[0].text.includes(TEST_TOKEN));
  });

  it("answers malformed JSON-RPC with proper error codes", async () => {
    const parse = await rpc.sendRaw("this is not json");
    assert.equal(parse.id, null);
    assert.equal(parse.error.code, -32700);

    const unknown = await rpc.request("no/such-method");
    assert.equal(unknown.error.code, -32601);

    const missingArg = await rpc.request("tools/call", {
      name: "kiln_workspace_create", arguments: { owner: "auro" },
    });
    assert.equal(missingArg.error.code, -32602);

    const unknownTool = await rpc.request("tools/call", {
      name: "kiln_nope", arguments: {},
    });
    assert.equal(unknownTool.error.code, -32602);
  });

  it("deletes a workspace through the guard (confirm = slug)", async () => {
    const list = await rpc.callToolJson("kiln_workspace_list", { owner: "auro" });
    const alpha = list.workspaces.find((w) => w.slug === "mcp-alpha");
    assert.ok(alpha);
    const refused = await rpc.callTool("kiln_workspace_delete", { id: alpha.id, confirm: "wrong" });
    assert.equal(refused.isError, true);
    const deleted = await rpc.callToolJson("kiln_workspace_delete", { id: alpha.id, confirm: "mcp-alpha" });
    assert.deepEqual(deleted, { ok: true, id: alpha.id });
    const after = await rpc.callToolJson("kiln_workspace_list", { owner: "auro" });
    assert.ok(!after.workspaces.some((w) => w.id === alpha.id));
  });
});
