# KILN Public Previews — every public app gets a URL

Caffeine-style public preview URLs for compute apps: deploy with
`"public": true` (or `node swarm.mjs compute preview --app <id> --enable`)
and the app is reachable at `https://<slug>.<domain>` — a real public URL
for a service running on the KILN box.

## Architecture

This VM has **no inbound path from the public internet** (its FQDN resolves
to an internal 198.18.x.x address, ports are unreachable externally, all
egress goes through a proxy). So previews are inside-out: the KILN box opens
**outbound** SSH reverse tunnels to a relay on hardware the architect
controls (his VPS), and the relay serves the public traffic.

```
                          VPS (relay, public)
                          ┌─────────────────────────────────┐
                          │ Caddy :443                      │
                          │  on-demand TLS for *.$DOMAIN    │
                          │       │                         │
                          │       v                         │
                          │ admin.mjs proxy 127.0.0.1:8080  │
                          │  Host slug.$DOMAIN ->           │
                          │       127.0.0.1:<relayPort>     │
                          └──────────┬──────────────────────┘
                                     │ ssh -R (inside-out)
                          ┌──────────┴──────────────────────┐
                          │ KILN box                        │
                          │  one supervised ssh -N bundle:  │
                          │   -R 127.0.0.1:<relayPort> :    │
                          │      127.0.0.1:<appPort> (×N)   │
                          │   -L 127.0.0.1:19191 :          │
                          │      127.0.0.1:19191 (admin)    │
                          │  10s reconciler keeps it alive  │
                          └─────────────────────────────────┘
```

- **One bundle, not one ssh per app.** The daemon holds a single `ssh -N`
  process carrying every `-R` forward plus one `-L` admin channel. When the
  set of public apps changes, the reconciler respawns the bundle with the
  new forward set. Fewer moving parts, one thing to supervise.
- **Slug registration is converged, not just appended.** After every
  (re)spawn the daemon syncs the relay registry (`GET /routes`, delete
  stale, `POST /register` for each desired slug), so the relay always
  reflects the desired set — even after unclean restarts.
- **TLS** terminates at Caddy with on-demand certificates. The relay's
  `/ask` hook only approves domains for slugs the daemon registered, so
  nobody can mint certs for arbitrary subdomains.
- **Remote binds are loopback-only.** The `-R` forwards bind `127.0.0.1` on
  the VPS (no `GatewayPorts`); the only public door is Caddy on 443.

## VPS setup (one command)

On a fresh Ubuntu VPS:

```bash
curl -fsSL <url>/setup.sh | sudo bash -s -- --domain preview.example.com
```

That installs Node 22 + Caddy, installs the relay admin as a systemd unit,
writes the Caddyfile (backing up any existing one), opens 80/443 in ufw,
generates the admin token, and installs a tunnel key (or use
`--ssh-pubkey "ssh-ed25519 AAAA..."` to use your own). At the end it prints
the exact `"preview"` JSON to paste into the KILN config plus the one line
to send back to the agent (relay ssh address + key path).

## KILN config

In `<stateDir>/config.json` (usually `~/.kiln-swarm/config.json`):

```json
"preview": {
  "mode": "ssh",
  "relay": "ssh://root@203.0.113.7",
  "key": "/home/hatch/.ssh/kiln_preview",
  "domain": "preview.example.com",
  "portRange": "19000-19099",
  "relayAdminUrl": "http://127.0.0.1:19191",
  "relayAdminToken": "<token printed by setup.sh>"
}
```

| Key | What |
|---|---|
| `mode` | `"ssh"` (production) or `"direct"` (test-only loopback — see below) |
| `relay` | ssh target for the tunnels, `ssh://user@host[:port]` |
| `key` | private key for that ssh connection; must exist and be mode 0600/0400 (ssh refuses anything looser, and so do we, with a clear error) |
| `domain` | public domain; app `my-api` becomes `https://my-api.preview.example.com` |
| `portRange` | relay ports allocated per public app, e.g. `"19000-19099"` |
| `relayAdminUrl` | where the daemon reaches the relay admin API — always through the ssh `-L` forward, so this stays a `127.0.0.1` URL |
| `relayAdminToken` | bearer token printed by `setup.sh`; travels in an `Authorization` header, never logged |

No `preview` key (or `preview: null`) → preview endpoints return
**HTTP 503 "preview relay not configured"** and apps deploy privately as
before. Nothing else changes.

`mode: "direct"` skips ssh entirely: the sidecar is a tiny Node TCP pipe
`relayPort → appPort` and `relayAdminUrl` points straight at a relay admin
you run yourself. It exists for loopback validation of the whole chain
(app → pipe → relay proxy → slug routing) without a VPS. The ssh hop is
the one link it doesn't test — but that hop is commodity `ssh -R`, verified
by hand on first VPS setup.

## The Caffeine-style UX

```bash
# deploy publicly from the start
node swarm.mjs compute deploy --name my-api --repo <url> --command node \
  --args '["server.mjs"]' --port 8905 --public
#   preview: https://my-api.preview.example.com

# or flip an existing app
node swarm.mjs compute preview --app my-api --enable
node swarm.mjs compute preview --app my-api --show
node swarm.mjs compute preview --app my-api --disable

# the apps list shows the URL column
node swarm.mjs compute apps
```

API:

| Method | Path | Effect |
|---|---|---|
| POST | `/v1/compute/apps` with `"public": true` | deploy + auto-enable preview |
| GET | `/v1/compute/apps` | each app carries `previewUrl` and `preview: {enabled, url, relayPort}` |
| GET | `/v1/compute/apps/:id` | same, for one app |
| POST | `/v1/compute/apps/:id/preview` | enable (503 when no relay configured) |
| DELETE | `/v1/compute/apps/:id/preview` | disable, unregister slug, free the port |

Undeploying an app tears its preview down first (slug unregistered, port
freed, tunnel dropped from the bundle).

## Honest limits

- **The relay is his VPS.** There is no KILN-operated relay network; the
  public URL works as long as his box is up and the VPS is up. The daemon
  logs (`[preview …]` lines in `daemon.log`) say exactly what the tunnel is
  doing.
- **Why not cloudflared / localtunnel / quick tunnels?** Verified on this
  VM, all dead ends: the VM has no public inbound path (FQDN → internal
  198.18.x.x), all egress goes via `hatch-egress-proxy:3128`; `cloudflared`
  ignores proxy env vars, `localtunnel` hangs behind the proxy. Anything
  that needs the public internet to dial *in* cannot work here — hence the
  inside-out ssh design, which only needs *outbound* ssh (reliably works).
- **`direct` mode is not production.** It's the loopback test rig. Real
  previews need the VPS relay.
- **WebSockets** are forwarded by the relay proxy (upgrade requests are
  spliced through), but exotic protocols beyond HTTP/WS aren't proxied.
- **One relay per daemon.** The config holds a single relay; multi-region
  fan-out is future work, not today's.
- **First ssh connect** uses `StrictHostKeyChecking=accept-new`: the VPS
  host key is recorded in `~/.ssh/known_hosts` on first tunnel open.
  `ServerAliveInterval=30` + the 10s reconciler respawn dead tunnels; short
  VPS reboots heal themselves.
