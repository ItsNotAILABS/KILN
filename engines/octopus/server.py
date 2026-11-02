#!/usr/bin/env python3
"""
Octopus engine service — a KILN compute-app candidate.

Thin stdlib HTTP wrapper over octopus.py (the pure core). No
dependencies, no state: quotes come in with each request, gaps and
conversions come out. Deploy as a KILN compute app (see DEPLOY.md)
or run standalone:  PORT=8911 python3 server.py

Routes:
  GET  /health            -> {"ok": true, "engine": "octopus", "version": 1}
  POST /v1/scan           {quotes, min_net_bps?, leg_cost_bps?}
                          -> {"ok": true, "gaps": [...], "assets": n}
  POST /v1/convert        {quotes, amount, from, to}
                          -> {"ok": true, "conversion": {...} | null}
Bad input answers 400 with the core's own error — loud, never faked.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

from octopus import build_graph, convert, find_gaps

MAX_BODY = 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the app log signal-clean
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "engine": "octopus", "version": 1})
        else:
            self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self._send(400, {"ok": False, "error": "body must be 1..1MB of JSON"})
        try:
            req = json.loads(self.rfile.read(length))
        except Exception as e:
            return self._send(400, {"ok": False, "error": f"invalid JSON: {e}"})
        try:
            graph = build_graph(req.get("quotes") or [])
            if self.path == "/v1/scan":
                gaps = find_gaps(
                    graph,
                    req.get("min_net_bps", 50),
                    leg_cost_bps=req.get("leg_cost_bps", 30.0),
                )
                # edges are keyed by tuples internally; gaps are plain dicts already
                return self._send(200, {"ok": True, "gaps": gaps, "assets": len(graph["assets"])})
            if self.path == "/v1/convert":
                out = convert(req["amount"], req["from"], req["to"], graph)
                return self._send(200, {"ok": True, "conversion": out})
            return self._send(404, {"ok": False, "error": "not_found"})
        except (ValueError, KeyError, TypeError) as e:
            return self._send(400, {"ok": False, "error": str(e)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8911"))
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
