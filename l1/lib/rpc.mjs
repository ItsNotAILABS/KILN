/** Tiny JSON-RPC helper. No deps. */
export async function rpc(url, method, params = [], { timeoutMs = 15_000, headers } = {}) {
  const hdrs = { "content-type": "application/json", ...(headers || {}) };
  const res = await fetch(url, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`rpc ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const j = await res.json();
  if (j.error) {
    const msg = j.error.message || JSON.stringify(j.error);
    const err = new Error(`${method}: ${msg}`);
    err.code = j.error.code;
    throw err;
  }
  return j.result;
}

export function localUrl(port, host = "127.0.0.1") {
  return `http://${host}:${port}`;
}
