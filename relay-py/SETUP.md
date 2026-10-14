# KILN laptop relay (tailnet mode)

Public preview URLs for KILN compute apps, relayed through the architect's
own laptop instead of a VPS. The relay is Python, stdlib only.

## How it works

```
public internet -> laptop:8080 (relay) -> tailnet tunnel -> this VM -> app:port
```

The relay speaks a tiny framed multiplex protocol (see `server.py` header).
KILN dials **out** from the VM to the laptop over Tailscale, so the VM needs
no inbound path. Many apps share one tunnel connection per app.

## What the laptop needs

- Python 3.10+
- Tailscale installed and logged in (the tunnel port is reached over the
  tailnet — it must **never** be exposed to the public internet)
- Optional: `cloudflared` for a public URL (option A below)

## Run it

```bash
python3 server.py --token <long-random-secret> --base-domain kiln.medinatechlabs.net
```

Flags: `--public-port 8080`, `--tunnel-port 8900`, `--bind 0.0.0.0`.
The token can also come from `KILN_RELAY_TOKEN` env. Keep a strong token —
it's the only auth on the tunnel port.

Find the laptop's tailnet IP with `tailscale ip -4` (looks like `100.x.y.z`).
The VM reaches the tunnel at `<that-ip>:8900` **through the runtime proxy**
(the KILN side handles the CONNECT hop; nothing for you to configure).

## Expose the public port

**Option A — instant testing (recommended first):** cloudflared quick tunnel

```bash
cloudflared tunnel --url http://localhost:8080
```

You get a `https://<random>.trycloudflare.com` URL. Set `publicBase` to it and
add `"subdomains": false` — KILN then uses `/apps/<slug>/` path routing,
which the relay strips before forwarding.

**Option B — real subdomains:** cloudflared named tunnel + wildcard DNS

1. `cloudflared tunnel create kiln-relay`
2. Route `*.kiln.medinatechlabs.net` (and `kiln.medinatechlabs.net`) to the
   tunnel in your DNS.
3. `cloudflared tunnel route dns <tunnel-id> '*.kiln.medinatechlabs.net'`
4. Run: `cloudflared tunnel run --url http://localhost:8080 kiln-relay`

Then apps get `https://<slug>.kiln.medinatechlabs.net`.

## VM side config (`~/.kiln-swarm/config.json`)

```json
{
  "preview": {
    "mode": "tailnet",
    "relayHost": "100.x.y.z",
    "relayPort": 8900,
    "token": "<same-secret-as-the-relay>",
    "publicBase": "https://kiln.medinatechlabs.net"
  }
}
```

- `relayHost`: the laptop's **tailnet** IP (`tailscale ip -4` on the laptop).
  The VM reaches it via the runtime CONNECT proxy automatically.
- `publicBase`: the public URL from option A or B above. Add
  `"subdomains": false` for option A (quick-tunnel URLs can't do subdomains).
- Then restart the KILN daemon and enable a preview:
  `swarm.mjs compute preview --app <appId>`

## Notes

- Tunnel port 8900: tailnet-only. Do not port-forward it on your router.
- Health: `GET http://localhost:8080/v1/health` → `{"ok":true}`.
- Routes: `GET http://localhost:8080/v1/routes` → `{"routes":[...]}`.
- Logs go to stdout: registers, stream opens, disconnects.
- Ctrl-C shuts down cleanly.
