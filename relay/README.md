# KILN public-preview relay

The relay is the public half of KILN's Caffeine-style preview URLs. It runs
on a box the architect controls (his VPS) because this VM has no inbound
path from the public internet.

```
browser --TLS--> Caddy (:443, on-demand certs for *.$DOMAIN)
                    |
                    v
              admin.mjs proxy (127.0.0.1:8080)
                    |
              Host: <slug>.$DOMAIN -> 127.0.0.1:<relayPort>
                    |
              ssh -R tunnel (opened inside-out from the KILN box)
                    |
              the compute app (127.0.0.1:<appPort> on the KILN box)
```

## Files

- `admin.mjs` — the whole relay: token-auth admin API + built-in reverse
  proxy. Node stdlib only, no npm. Run it directly for local testing:
  `DOMAIN=preview.test TOKEN_FILE=./admin.token RELAY_PORT=19391 PROXY_PORT=18080 node admin.mjs`
- `setup.sh` — one-command VPS installer:
  `curl -fsSL <url>/setup.sh | sudo bash -s -- --domain preview.example.com`

## Admin API (127.0.0.1 only, Bearer token)

| Method | Path | What |
|---|---|---|
| POST | `/register` `{slug, port}` | map `slug.$DOMAIN` -> `127.0.0.1:port` |
| DELETE | `/register/:slug` | remove a mapping (idempotent) |
| GET | `/routes` | list mappings (debug) |
| GET | `/ask?domain=` | Caddy on-demand TLS hook: 200 only for registered slugs |
| GET | `/health` | `{ok:true}` (no auth) |

The KILN daemon calls these through its ssh `-L` admin channel — the admin
port is never exposed publicly.

## Security notes

- Remote `-R` binds are `127.0.0.1`-only on the VPS (no `GatewayPorts`):
  the only way in is through Caddy on 443.
- The relay never sees the KILN box's API token, and KILN never logs the
  relay admin token.
- On-demand TLS only issues for slugs the KILN daemon registered (the
  `/ask` hook), with `interval`/`burst` guards in the Caddyfile.
