#!/usr/bin/env python3
"""KILN laptop relay — public-preview relay that runs on the architect's own
machine. Stdlib only (asyncio). Python 3.10+.

Two listeners:
  * public HTTP  on 0.0.0.0:8080  (--public-port)  — what the world hits
  * tunnel        on 0.0.0.0:8900  (--tunnel-port)   — spoken only by KILN

The tunnel port only needs to be reachable over the TAILNET (Tailscale),
never the public internet. The public port is what you expose (cloudflared,
port-forward, etc.).

Wire protocol (both directions), length-prefixed frames:
  u32 big-endian length, u8 type, payload          (length = 1 + len(payload))
  0x01 REGISTER      JSON {"token":..., "slug":...}      (VM -> relay)
  0x02 REGISTERED    JSON {"ok":true} | {"ok":false,"error":...}
  0x10 STREAM_OPEN   u32 BE streamId                        (relay -> VM)
  0x11 STREAM_DATA   u32 BE streamId + bytes                (both ways)
  0x12 STREAM_CLOSE  u32 BE streamId                        (both ways)
  0x03 PING / 0x04 PONG keepalive (both ways; 25s interval, 90s silence = drop)

Routing: by subdomain <slug>.<base-domain> (Host header), else by path
prefix /apps/<slug>/ (prefix is STRIPPED before forwarding). No tunnel for
the slug -> 502 with a plain-text explanation.

Also serves on the public port (no auth): GET /v1/health -> {"ok":true},
GET /v1/routes -> {"routes":[slugs]} (optional ?token= check when a token
is configured).
"""
import argparse
import asyncio
import json
import logging
import os
import struct
import sys
import time
import urllib.parse

# Frame types
F_REGISTER = 0x01
F_REGISTERED = 0x02
F_PING = 0x03
F_PONG = 0x04
F_STREAM_OPEN = 0x10
F_STREAM_DATA = 0x11
F_STREAM_CLOSE = 0x12

PING_INTERVAL = 25.0
PEER_TIMEOUT = 90.0
MAX_HEAD = 65536  # max HTTP request head size

log = logging.getLogger("kiln-relay")


def encode_frame(ftype: int, payload: bytes) -> bytes:
    """u32 BE length, u8 type, payload. length = 1 + len(payload)."""
    if not (0 <= ftype <= 255):
        raise ValueError("bad frame type")
    return struct.pack(">IB", len(payload) + 1, ftype) + payload


async def read_frame(reader: asyncio.StreamReader):
    """Returns (ftype, payload) or (None, None) on EOF."""
    try:
        hdr = await reader.readexactly(5)
    except (asyncio.IncompleteReadError, ConnectionError):
        return None, None
    (length,) = struct.unpack(">I", hdr[:4])
    ftype = hdr[4]
    if length < 1 or length > 16 * 1024 * 1024:
        raise ValueError(f"bad frame length {length}")
    try:
        payload = await reader.readexactly(length - 1)
    except (asyncio.IncompleteReadError, ConnectionError):
        return None, None
    return ftype, payload


class Tunnel:
    """One VM-side tunnel connection, carrying many multiplexed streams."""

    def __init__(self, relay, reader, writer):
        self.relay = relay
        self.reader = reader
        self.writer = writer
        self.slug = None
        self.streams = {}  # streamId -> asyncio.StreamWriter (public side)
        self.next_stream = 1
        self.last_seen = time.monotonic()
        self.peer = writer.get_extra_info("peername")
        self._closed = False

    async def send(self, ftype, payload=b""):
        if self._closed:
            return
        try:
            self.writer.write(encode_frame(ftype, payload))
            await self.writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            raise
        except Exception:
            await self.close()

    async def close(self):
        if self._closed:
            return
        self._closed = True
        for sid, w in list(self.streams.items()):
            try:
                w.close()
            except Exception:
                pass
        self.streams.clear()
        try:
            self.writer.close()
        except Exception:
            pass
        if self.slug:
            self.relay.unregister(self, self.slug)

    async def run(self):
        try:
            # First frame must be REGISTER.
            ftype, payload = await read_frame(self.reader)
            if ftype != F_REGISTER:
                await self.send(
                    F_REGISTERED,
                    json.dumps({"ok": False, "error": "expected REGISTER"}).encode(),
                )
                return
            try:
                reg = json.loads(payload.decode("utf-8"))
            except Exception:
                reg = {}
            token = reg.get("token", "")
            slug = str(reg.get("slug", "")).strip().lower()
            if token != self.relay.token:
                await self.send(
                    F_REGISTERED,
                    json.dumps({"ok": False, "error": "bad token"}).encode(),
                )
                log.warning("register rejected (bad token) from %s", self.peer)
                return
            if not slug or not self.relay.valid_slug(slug):
                await self.send(
                    F_REGISTERED,
                    json.dumps({"ok": False, "error": "bad slug"}).encode(),
                )
                return
            self.slug = slug
            self.relay.register(self, slug)
            await self.send(F_REGISTERED, json.dumps({"ok": True}).encode())
            log.info("tunnel registered: %s <- %s", slug, self.peer)

            ping_task = asyncio.create_task(self._ping_loop())
            try:
                while True:
                    ftype, payload = await read_frame(self.reader)
                    if ftype is None:
                        break  # EOF
                    self.last_seen = time.monotonic()
                    if ftype == F_PING:
                        await self.send(F_PONG)
                    elif ftype == F_PONG:
                        pass  # last_seen updated above
                    elif ftype == F_STREAM_DATA:
                        if len(payload) >= 4:
                            sid = struct.unpack(">I", payload[:4])[0]
                            w = self.streams.get(sid)
                            if w is not None and not w.is_closing():
                                try:
                                    w.write(payload[4:])
                                    await w.drain()
                                except (ConnectionError, BrokenPipeError):
                                    await self._stream_closed(sid)
                    elif ftype == F_STREAM_CLOSE:
                        if len(payload) >= 4:
                            sid = struct.unpack(">I", payload[:4])[0]
                            await self._stream_closed(sid)
                    # unknown types ignored
            finally:
                ping_task.cancel()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception as e:
            log.warning("tunnel %s error: %s", self.slug or self.peer, e)
        finally:
            await self.close()
            log.info("tunnel closed: %s (%s)", self.slug or "?", self.peer)

    async def _stream_closed(self, sid):
        w = self.streams.pop(sid, None)
        if w is not None:
            try:
                w.close()
            except Exception:
                pass

    async def _ping_loop(self):
        try:
            while True:
                await asyncio.sleep(PING_INTERVAL)
                if time.monotonic() - self.last_seen > PEER_TIMEOUT:
                    log.warning("tunnel %s silent >90s, dropping", self.slug)
                    await self.close()
                    return
                await self.send(F_PING)
        except asyncio.CancelledError:
            pass


class Relay:
    def __init__(self, token, base_domain):
        self.token = token
        self.base_domain = base_domain.lower().rstrip(".")
        self.tunnels = {}  # slug -> Tunnel
        self.lock = asyncio.Lock()

    @staticmethod
    def valid_slug(slug):
        if not (1 <= len(slug) <= 63):
            return False
        if not (slug[0].isalnum() and slug[-1].isalnum()):
            return False
        return all(c.isalnum() or c in "-." for c in slug)

    def register(self, tunnel, slug):
        old = self.tunnels.get(slug)
        if old is not None and old is not tunnel:
            # Replace: the old connection's close() will unregister itself,
            # so only overwrite after scheduling its teardown.
            asyncio.create_task(old.close())
        self.tunnels[slug] = tunnel

    def unregister(self, tunnel, slug):
        if self.tunnels.get(slug) is tunnel:
            del self.tunnels[slug]

    async def open_stream(self, slug, head: bytes):
        """Returns (tunnel, streamId) or (None, None) when no tunnel."""
        async with self.lock:
            tunnel = self.tunnels.get(slug)
            if tunnel is None or tunnel._closed:
                return None, None
            sid = tunnel.next_stream
            tunnel.next_stream = (tunnel.next_stream + 1) & 0xFFFFFFFF or 1
            try:
                await tunnel.send(F_STREAM_OPEN, struct.pack(">I", sid))
                await tunnel.send(F_STREAM_DATA, struct.pack(">I", sid) + head)
            except Exception:
                return None, None
            return tunnel, sid


async def handle_public(relay: Relay, reader, writer):
    peer = writer.get_extra_info("peername")
    try:
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = await asyncio.wait_for(reader.read(4096), timeout=15)
            if not chunk:
                break
            head += chunk
            if len(head) > MAX_HEAD:
                writer.write(b"HTTP/1.1 431 Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await writer.drain()
                writer.close()
                return
        if b"\r\n\r\n" not in head:
            writer.close()
            return
        raw_head, rest = head.split(b"\r\n\r\n", 1)
        try:
            text = raw_head.decode("latin-1")
        except Exception:
            writer.close()
            return
        lines = text.split("\r\n")
        request_line = lines[0]
        parts = request_line.split(" ")
        if len(parts) < 2:
            writer.close()
            return
        method, target = parts[0].upper(), parts[1]
        headers = {}
        for ln in lines[1:]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        path = urllib.parse.urlsplit(target).path or "/"
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(target).query)

        # Built-ins (served locally, never forwarded).
        if method == "GET" and path == "/v1/health":
            body = b'{"ok":true}'
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body
            )
            await writer.drain()
            writer.close()
            return
        if method == "GET" and path == "/v1/routes":
            tok = query.get("token", [None])[0]
            if relay.token and tok is not None and tok != relay.token:
                writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await writer.drain()
                writer.close()
                return
            body = json.dumps({"routes": sorted(relay.tunnels.keys())}).encode()
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body
            )
            await writer.drain()
            writer.close()
            return

        # Resolve slug: subdomain first, then /apps/<slug>/ path prefix.
        slug = None
        forward_head = raw_head + b"\r\n\r\n" + rest
        host = headers.get("host", "").split(":")[0].lower().rstrip(".")
        if relay.base_domain and host.endswith("." + relay.base_domain):
            slug = host[: -(len(relay.base_domain) + 1)]
        elif path == "/apps" or path.startswith("/apps/"):
            segs = path.split("/")
            if len(segs) >= 3 and segs[2]:
                slug = segs[2].lower()
                # Strip the /apps/<slug> prefix before forwarding.
                stripped = "/" + "/".join(segs[3:])
                if target.startswith("/"):
                    new_target = stripped + (
                        ("?" + urllib.parse.urlsplit(target).query)
                        if urllib.parse.urlsplit(target).query else ""
                    )
                    new_request_line = f"{method} {new_target} HTTP/1.1"
                    new_lines = [new_request_line] + lines[1:]
                    forward_head = ("\r\n".join(new_lines) + "\r\n\r\n").encode("latin-1") + rest

        if not slug or not Relay.valid_slug(slug):
            msg = b"no app for this host/path"
            writer.write(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: "
                + str(len(msg)).encode() + b"\r\nConnection: close\r\n\r\n" + msg
            )
            await writer.drain()
            writer.close()
            return

        tunnel, sid = await relay.open_stream(slug, forward_head)
        if tunnel is None:
            msg = f"no tunnel registered for app '{slug}'".encode()
            writer.write(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: "
                + str(len(msg)).encode() + b"\r\nConnection: close\r\n\r\n" + msg
            )
            await writer.drain()
            writer.close()
            return
        tunnel.streams[sid] = writer
        log.info("stream %d -> %s (%s)", sid, slug, peer)

        async def pump():
            try:
                while True:
                    chunk = await reader.read(65536)
                    if not chunk:
                        break
                    await tunnel.send(F_STREAM_DATA, struct.pack(">I", sid) + chunk)
            except (ConnectionError, asyncio.CancelledError):
                pass
            finally:
                tunnel.streams.pop(sid, None)
                try:
                    await tunnel.send(F_STREAM_CLOSE, struct.pack(">I", sid))
                except Exception:
                    pass
                try:
                    writer.close()
                except Exception:
                    pass

        await pump()
    except (ConnectionError, asyncio.TimeoutError):
        try:
            writer.close()
        except Exception:
            pass
    except Exception as e:
        log.warning("public handler error from %s: %s", peer, e)
        try:
            writer.close()
        except Exception:
            pass


async def handle_tunnel(relay: Relay, reader, writer):
    await Tunnel(relay, reader, writer).run()


async def amain(args):
    token = args.token or os.environ.get("KILN_RELAY_TOKEN", "")
    if not token:
        print("error: --token or KILN_RELAY_TOKEN is required", file=sys.stderr)
        return 2
    relay = Relay(token, args.base_domain or "")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    public_srv = await asyncio.start_server(
        lambda r, w: handle_public(relay, r, w), args.bind, args.public_port
    )
    tunnel_srv = await asyncio.start_server(
        lambda r, w: handle_tunnel(relay, r, w), args.bind, args.tunnel_port
    )
    log.info(
        "relay up: public=%s:%d tunnel=%s:%d base-domain=%s",
        args.bind, args.public_port, args.bind, args.tunnel_port,
        relay.base_domain or "(none)",
    )
    log.info("NOTE: the tunnel port only needs tailnet reachability, never the public internet.")
    async with public_srv, tunnel_srv:
        await asyncio.gather(public_srv.serve_forever(), tunnel_srv.serve_forever())


def main():
    ap = argparse.ArgumentParser(description="KILN laptop relay (stdlib asyncio)")
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--public-port", type=int, default=8080)
    ap.add_argument("--tunnel-port", type=int, default=8900)
    ap.add_argument("--base-domain", default="",
                    help="e.g. kiln.medinatechlabs.net (enables <slug>.<domain> routing)")
    ap.add_argument("--token", default="",
                    help="shared secret; or KILN_RELAY_TOKEN env")
    args = ap.parse_args()
    try:
        rc = asyncio.run(amain(args))
    except KeyboardInterrupt:
        rc = 0
    sys.exit(rc or 0)


if __name__ == "__main__":
    main()
