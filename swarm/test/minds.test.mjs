/** Minds: script mind executes for real; http mind needs a real endpoint or refuses. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScriptMind, runHttpMind } from "../lib/minds.mjs";
import { makeStateDir, makeNode } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("script mind", () => {
  it("executes a multi-step plan for real", async () => {
    const dir = makeStateDir();
    const { ctx, node } = await makeNode(dir);
    const summary = await runScriptMind(ctx, {
      steps: [
        { tool: "fs.write", args: { path: "plan.txt", content: "step one\n" } },
        { tool: "shell.exec", args: { command: "cat", args: ["plan.txt"] } },
        { tool: "fs.list", args: {} },
      ],
    });
    assert.match(summary, /3\/3 steps ok/);
    assert.equal(readFileSync(join(node.workdir, "plan.txt"), "utf8"), "step one\n");
  });
  it("fails fast on a bad step and says which one", async () => {
    const dir = makeStateDir();
    const { ctx } = await makeNode(dir);
    await assert.rejects(
      () => runScriptMind(ctx, {
        steps: [
          { tool: "fs.write", args: { path: "ok.txt", content: "x" } },
          { tool: "nope.not-a-tool", args: {} },
        ],
      }),
      /step 1 \(nope\.not-a-tool\)/
    );
  });
  it("rejects a plan without steps", async () => {
    const dir = makeStateDir();
    const { ctx } = await makeNode(dir);
    await assert.rejects(() => runScriptMind(ctx, {}), /plan\.steps\[\] is required/);
  });
});

describe("http mind", () => {
  function stubServer(handler) {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const out = handler(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
  }

  it("drives real tool calls against a stub completions server", async () => {
    let calls = 0;
    const { server, port } = await stubServer((req) => {
      calls++;
      assert.ok(Array.isArray(req.tools), "mind must send tool schemas");
      assert.ok(req.tools.some((t) => t.function.name === "fs.write"), "fs.write must be offered");
      if (calls === 1) {
        return {
          choices: [{
            message: {
              tool_calls: [{
                id: "call_1", type: "function",
                function: { name: "fs.write", arguments: JSON.stringify({ path: "mind.txt", content: "via http mind\n" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
        };
      }
      return { choices: [{ message: { content: "file written, task complete" }, finish_reason: "stop" }] };
    });
    const dir = makeStateDir();
    const { ctx, node } = await makeNode(dir);
    const oldUrl = process.env.KILN_MIND_URL;
    process.env.KILN_MIND_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
    try {
      const summary = await runHttpMind(ctx, { brief: "write mind.txt" });
      assert.match(summary, /task complete/);
      assert.equal(calls, 2);
      assert.equal(readFileSync(join(node.workdir, "mind.txt"), "utf8"), "via http mind\n");
    } finally {
      if (oldUrl === undefined) delete process.env.KILN_MIND_URL;
      else process.env.KILN_MIND_URL = oldUrl;
      server.close();
    }
  });

  it("REFUSES LOUDLY with no KILN_MIND_URL — never pretends", async () => {
    const dir = makeStateDir();
    const { ctx } = await makeNode(dir);
    const oldUrl = process.env.KILN_MIND_URL;
    delete process.env.KILN_MIND_URL;
    try {
      await assert.rejects(() => runHttpMind(ctx, { brief: "anything" }), /KILN_MIND_URL is not configured/);
    } finally {
      if (oldUrl !== undefined) process.env.KILN_MIND_URL = oldUrl;
    }
  });

  it("fails loudly on a non-JSON endpoint", async () => {
    const { server, port } = await stubServer(() => "not json shaped");
    // handler returns a string; server JSON.stringifies it -> valid JSON but wrong shape
    const dir = makeStateDir();
    const { ctx } = await makeNode(dir);
    const oldUrl = process.env.KILN_MIND_URL;
    process.env.KILN_MIND_URL = `http://127.0.0.1:${port}/x`;
    try {
      await assert.rejects(() => runHttpMind(ctx, {}), /no choices\[0\]\.message|did not return JSON/);
    } finally {
      if (oldUrl === undefined) delete process.env.KILN_MIND_URL;
      else process.env.KILN_MIND_URL = oldUrl;
      server.close();
    }
  });

  it("runs the examples/long-task.json template shape end to end", async () => {
    // The worker hands a long-task job to the http mind as
    //   brief = `${job.name}: ${JSON.stringify(job.plan)}`
    // (see lib/worker.mjs runJob). Prove that exact shape works.
    const plan = JSON.parse(readFileSync(join(HERE, "..", "examples", "long-task.json"), "utf8"));
    assert.ok(typeof plan.task === "string" && plan.task.length > 0, "template needs a task brief");
    let calls = 0;
    let sawBrief = "";
    const { server, port } = await stubServer((req) => {
      calls++;
      sawBrief = req.messages.find((m) => m.role === "user")?.content || "";
      assert.ok(sawBrief.includes("my-long-task"), "stub: job name must reach the model in the brief");
      assert.ok(sawBrief.includes(plan.task.slice(0, 40)), "stub: template task text must reach the model");
      if (calls === 1) {
        return {
          choices: [{
            message: {
              tool_calls: [{
                id: "call_lt", type: "function",
                function: { name: "fs.write", arguments: JSON.stringify({ path: "LONGTASK.md", content: "long task done\n" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
        };
      }
      return { choices: [{ message: { content: "long task complete" }, finish_reason: "stop" }] };
    });
    const dir = makeStateDir();
    const { ctx, node } = await makeNode(dir);
    const oldUrl = process.env.KILN_MIND_URL;
    process.env.KILN_MIND_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
    try {
      // Exactly what worker.mjs does for a mind=http job:
      const brief = `my-long-task: ${JSON.stringify(plan).slice(0, 2000)}`;
      const summary = await runHttpMind(ctx, { brief });
      assert.match(summary, /long task complete/);
      assert.equal(calls, 2);
      assert.equal(readFileSync(join(node.workdir, "LONGTASK.md"), "utf8"), "long task done\n");
    } finally {
      if (oldUrl === undefined) delete process.env.KILN_MIND_URL;
      else process.env.KILN_MIND_URL = oldUrl;
      server.close();
    }
  });
});
