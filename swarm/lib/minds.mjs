/**
 * Minds: the decision loop behind a worker. Pluggable interface.
 *
 *  - script mind: executes a declarative plan {steps:[{tool,args}]} — real
 *    tool calls, receipts, fail-fast. Genuinely useful for long scripted tasks.
 *  - http mind: POSTs to a chat-completions endpoint from KILN_MIND_URL
 *    (OpenAI-compatible tool_calls). With no URL configured it REFUSES LOUDLY
 *    — it never pretends to think.
 */
import { runTool, TOOL_DEFS } from "./tools.mjs";
import { GrantError } from "./grant.mjs";

function toolSchemas() {
  return TOOL_DEFS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: `${t.desc}. Args: ${JSON.stringify(t.args)}`,
      parameters: { type: "object", additionalProperties: true },
    },
  }));
}

/** Run a declarative plan for real. Returns a summary string. */
export async function runScriptMind(ctx, plan) {
  if (!plan || !Array.isArray(plan.steps)) {
    throw new Error("script mind: plan.steps[] is required");
  }
  const done = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step || typeof step.tool !== "string") {
      throw new Error(`script mind: step ${i} has no tool`);
    }
    let r;
    try {
      r = await runTool(ctx, step.tool, step.args || {});
    } catch (e) {
      // Grant expiry mid-plan is fatal to the worker, not just the step.
      if (e instanceof GrantError && e.code === "GRANT_EXPIRED") throw e;
      throw new Error(`script mind: step ${i} (${step.tool}) threw: ${e.message}`);
    }
    if (!r.ok) {
      throw new Error(`script mind: step ${i} (${step.tool}) failed: ${r.error}`);
    }
    done.push(`${step.tool}: ${(r.out || "").slice(0, 120)}`);
  }
  return `plan complete: ${done.length}/${plan.steps.length} steps ok` +
    (done.length ? ` — ${done[done.length - 1]}` : "");
}

const HTTP_TIMEOUT_MS = 120000;
const MAX_TURNS = 25;

/**
 * OpenAI-compatible chat-completions mind.
 * Env: KILN_MIND_URL (required), KILN_MIND_MODEL (optional), KILN_MIND_API_KEY (optional).
 */
export async function runHttpMind(ctx, opts = {}) {
  const url = process.env.KILN_MIND_URL;
  if (!url) {
    throw new Error(
      "http mind: KILN_MIND_URL is not configured — refusing to run. " +
      "Set KILN_MIND_URL to a chat-completions endpoint (and KILN_MIND_API_KEY if needed)."
    );
  }
  const model = process.env.KILN_MIND_MODEL || "kiln-worker";
  const headers = { "content-type": "application/json" };
  if (process.env.KILN_MIND_API_KEY) headers.authorization = `Bearer ${process.env.KILN_MIND_API_KEY}`;

  const brief = opts.brief || "Do useful work with the tools available.";
  const messages = [
    {
      role: "system",
      content:
        `You are a headless worker node (${ctx.nodeId}) in the KILN swarm. ` +
        `You act ONLY through the provided tools. Every call is executed for real and receipted. ` +
        `Work dir is jailed. When the task is complete, stop calling tools and summarize.`,
    },
    { role: "user", content: `Task: ${brief}` },
  ];
  const tools = toolSchemas();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body = JSON.stringify({ model, messages, tools, tool_choice: "auto" });
    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
      res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
      clearTimeout(t);
    } catch (e) {
      throw new Error(`http mind: request failed: ${e.message}`);
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new Error(`http mind: endpoint returned HTTP ${res.status}: ${text}`);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("http mind: endpoint did not return JSON — refusing to guess its protocol");
    }
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error("http mind: response has no choices[0].message — refusing to guess its protocol");
    messages.push({ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls || undefined });

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      return `http mind done after ${turn + 1} turn(s): ${(msg.content || "").slice(0, 500)}`;
    }
    for (const c of calls) {
      const name = c?.function?.name;
      let targs = {};
      try {
        targs = c?.function?.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        throw new Error(`http mind: tool ${name} had non-JSON arguments — refusing to guess`);
      }
      let r;
      try {
        r = await runTool(ctx, name, targs);
      } catch (e) {
        if (e instanceof GrantError && e.code === "GRANT_EXPIRED") throw e;
        r = { ok: false, error: `threw: ${e.message}` };
      }
      messages.push({
        role: "tool",
        tool_call_id: c.id,
        content: r.ok ? String(r.out || "ok").slice(0, 4000) : `ERROR: ${r.error}`,
      });
      if (!r.ok && /GRANT_EXPIRED/.test(r.error || "")) {
        throw new Error("http mind: grant expired mid-run — stopping");
      }
    }
  }
  throw new Error(`http mind: exceeded ${MAX_TURNS} turns without finishing`);
}
