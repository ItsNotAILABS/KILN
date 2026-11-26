/** Tiny JSON-RPC helper. No deps. Error messages never include the RPC URL. */
import { sanitizeErrorMessage } from "./chains.mjs";

export async function rpc(url, method, params = [], { timeoutMs = 15_000, headers } = {}) {
  try {
    const hdrs = { "content-type": "application/json", ...(headers || {}) };
    const res = await fetch(url, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`rpc ${method}: HTTP ${res.status} ${sanitizeErrorMessage(text.slice(0, 200), url)}`);
    }
    const j = await res.json();
    if (j.error) {
      const msg = j.error.message || JSON.stringify(j.error);
      const err = new Error(`${method}: ${sanitizeErrorMessage(msg, url)}`);
      err.code = j.error.code;
      throw err;
    }
    return j.result;
  } catch (e) {
    const safe = sanitizeErrorMessage(e.message || String(e), url);
    if (e && e.message === safe && (e.message.startsWith("rpc ") || e.message.startsWith(`${method}:`))) throw e;
    const err = new Error(safe.startsWith("rpc ") || safe.startsWith(`${method}:`) ? safe : `rpc ${method}: ${safe}`);
    if (e && e.code != null) err.code = e.code;
    throw err;
  }
}

export function localUrl(port, host = "127.0.0.1") {
  return `http://${host}:${port}`;
}
