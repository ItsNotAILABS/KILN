/**
 * transfer-http.mjs — operator-only daemon routes for agent transfer:
 *   POST /v1/transfers            start a recv, send, tree-send, or relay
 *   GET  /v1/transfers            list
 *   GET  /v1/transfers/{id}       status
 *   DELETE /v1/transfers/{id}     cancel
 *   GET  /v1/transfers/{id}/receipt
 *   POST /v1/transfers/{id}/receipt   build or submit-and-confirm (never mainnet)
 *
 * Auth is the same gate as /v1/vcomputers: anything past the account-scope
 * guard is operator-only.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./state.mjs";
import {
  startReceiver, sendFile, sendPath, sendTree, loadIdentity, startRelay,
  submitAndConfirmMemoReceipt, buildMemoReceipt, parseAddr,
} from "./transfer.mjs";
import { loadKeypairFile } from "./transfer-identity.mjs";

const ID_RE = /^tx_[0-9a-f]{12}$/;

export class TransferApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function root(dir) { return join(dir, "transfers"); }
function pathOf(dir, id) { return join(root(dir), id + ".json"); }
function save(dir, rec) {
  mkdirSync(root(dir), { recursive: true, mode: 0o700 });
  writeFileAtomicSync(pathOf(dir, rec.id), JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
}
function load(dir, id) {
  if (!ID_RE.test(String(id))) throw new TransferApiError(404, `no such transfer ${id}`);
  const p = pathOf(dir, id);
  if (!existsSync(p)) throw new TransferApiError(404, `no such transfer ${id}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

const live = new Map();

export async function startTransfer(dir, body = {}) {
  const id = "tx_" + randomBytes(6).toString("hex");
  const keypair = body.keypairFile ? loadKeypairFile(body.keypairFile) : loadIdentity(dir);
  const role = body.role || (body.path || body.to || body.targets ? "send" : "recv");
  const rec = { id, role, state: "starting", createdAt: new Date().toISOString(), encrypt: body.encrypt !== false };
  save(dir, rec);
  try {
    if (role === "relay") {
      const r = await startRelay({ host: body.host || "127.0.0.1", port: body.port || 0 });
      rec.state = "listening"; rec.host = r.host; rec.port = r.port;
      live.set(id, { close: r.close, kind: "relay" });
      save(dir, rec);
      return rec;
    }
    if (role === "recv") {
      const rx = await startReceiver({
        outDir: body.outDir || join(root(dir), id, "inbox"),
        host: body.host || "127.0.0.1", port: body.port || 0, keypair,
        trust: body.trust, encrypt: body.encrypt !== false, transport: body.transport || "tcp",
        via: body.via, token: body.token, rendezvous: body.rendezvous, overwrite: !!body.overwrite,
        onComplete: async (result) => { rec.state = "complete"; rec.result = result; save(dir, rec); },
      });
      rec.state = "listening"; rec.host = rx.host; rec.port = rx.port;
      rec.publicKey = rx.publicKey; rec.token = rx.token; rec.outDir = rx.outDir; rec.via = !!rx.via;
      live.set(id, { close: rx.close, kind: "recv" });
      save(dir, rec);
      return rec;
    }
    if (role === "send") {
      rec.state = "sending"; rec.path = body.path; save(dir, rec);
      const opts = {
        keypair, expectReceiver: body.expect, encrypt: body.encrypt !== false,
        transport: body.transport || "tcp", via: body.via, token: body.token,
        rendezvous: body.rendezvous, forceRelay: !!body.forceRelay, streams: body.streams,
      };
      if (body.to) Object.assign(opts, parseAddr(body.to));
      if (body.host) opts.host = body.host;
      if (body.port) opts.port = body.port;
      const run = body.targets
        ? sendTree(body.path, body.targets, { ...opts, fanout: body.fanout })
        : sendPath(body.path, opts);
      const p = run.then(async (stats) => {
        rec.state = "complete"; rec.result = stats;
        const manifestId = stats.id;
        if (body.receipt?.rpcUrl) {
          try { rec.receipt = await submitAndConfirmMemoReceipt({ rpcUrl: body.receipt.rpcUrl, keypair, manifestId }); }
          catch (e) { rec.receiptError = e.message; }
        } else if (manifestId) {
          rec.receipt = { ...buildMemoReceipt({ keypair, manifestId, recentBlockhash: "11111111111111111111111111111111" }), submitted: false };
        }
        save(dir, rec);
        return stats;
      }).catch((e) => { rec.state = "failed"; rec.error = e.message; save(dir, rec); throw e; });
      live.set(id, { close: async () => {}, promise: p, kind: "send" });
      if (body.waitMs) {
        await Promise.race([
          p,
          new Promise((_, j) => setTimeout(() => j(new TransferApiError(504, "send still running")), Number(body.waitMs))),
        ]);
      }
      save(dir, rec);
      return rec;
    }
    throw new TransferApiError(400, "role must be recv, send, or relay");
  } catch (e) {
    rec.state = rec.state === "complete" ? rec.state : "failed";
    rec.error = rec.error || e.message;
    save(dir, rec);
    if (e instanceof TransferApiError) throw e;
    throw new TransferApiError(400, e.message);
  }
}

export function listTransfers(dir) {
  const d = root(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(d, f), "utf8")))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
export function getTransfer(dir, id) { return load(dir, id); }
export async function cancelTransfer(dir, id) {
  const rec = load(dir, id);
  const h = live.get(id);
  if (h?.close) await h.close();
  live.delete(id);
  if (rec.state !== "complete") rec.state = "cancelled";
  rec.cancelledAt = new Date().toISOString();
  save(dir, rec);
  return rec;
}
export function getReceipt(dir, id) {
  const rec = load(dir, id);
  if (rec.receipt) return rec.receipt;
  throw new TransferApiError(404, "no receipt for this transfer yet — finish a send, or POST /v1/transfers/{id}/receipt");
}
export async function postReceipt(dir, id, body = {}) {
  const rec = load(dir, id);
  const manifestId = body.manifestId || rec.result?.id;
  if (!manifestId) throw new TransferApiError(400, "no manifest id; finish a send or pass manifestId");
  const keypair = body.keypairFile ? loadKeypairFile(body.keypairFile) : loadIdentity(dir);
  if (body.submit) {
    rec.receipt = await submitAndConfirmMemoReceipt({ rpcUrl: body.rpcUrl, keypair, manifestId });
  } else {
    rec.receipt = { ...buildMemoReceipt({ keypair, manifestId, recentBlockhash: body.blockhash || "11111111111111111111111111111111" }), submitted: false };
  }
  save(dir, rec);
  return rec.receipt;
}

export async function handleTransferApi(req, res, path, url, dir, { send, readBody }) {
  if (path !== "/v1/transfers" && !path.startsWith("/v1/transfers/")) return false;
  try {
    const m = path.match(/^\/v1\/transfers\/(tx_[0-9a-f]{12})(\/receipt)?$/);
    if (req.method === "POST" && path === "/v1/transfers") return send(res, 201, await startTransfer(dir, await readBody(req))), true;
    if (req.method === "GET" && path === "/v1/transfers") return send(res, 200, { transfers: listTransfers(dir) }), true;
    if (m && !m[2]) {
      if (req.method === "GET") return send(res, 200, getTransfer(dir, m[1])), true;
      if (req.method === "DELETE") return send(res, 200, await cancelTransfer(dir, m[1])), true;
    }
    if (m && m[2] === "/receipt") {
      if (req.method === "GET") return send(res, 200, getReceipt(dir, m[1])), true;
      if (req.method === "POST") return send(res, 200, await postReceipt(dir, m[1], await readBody(req))), true;
    }
    return send(res, 404, { error: "not found" }), true;
  } catch (e) {
    if (e instanceof TransferApiError) return send(res, e.status, { error: e.message }), true;
    throw e;
  }
}
