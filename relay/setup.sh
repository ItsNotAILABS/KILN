#!/usr/bin/env bash
# kiln-relay setup — one-command installer for a fresh Ubuntu VPS.
#
# Installs Node 22 (nodesource) + Caddy (official apt repo), drops in the
# KILN preview relay admin as a systemd service, configures Caddy with
# on-demand TLS for *.<domain> reverse-proxying to the admin's built-in
# proxy, opens 80/443 in ufw, generates the admin token, and prints the
# exact KILN config.json "preview" snippet at the end.
#
# Usage:
#   curl -fsSL <url>/setup.sh | sudo bash -s -- --domain preview.example.com
#
# Flags:
#   --domain DOMAIN        (required) the preview domain, e.g. preview.example.com
#   --base-url URL         where to fetch admin.mjs from (default: the KILN
#                          repo on GitHub; falls back to a sibling admin.mjs)
#   --ssh-pubkey "KEY"     public key allowed to open tunnels (skips keygen;
#                          the private key then already lives on your KILN box)
#   --admin-port PORT      relay admin port on 127.0.0.1 (default 19191)
#   --proxy-port PORT      relay proxy port on 127.0.0.1 (default 8080)
#   --no-ufw               skip ufw changes
#
# What it does NOT do: it never touches your existing sites — it backs up
# /etc/caddy/Caddyfile to Caddyfile.bak first. Re-run safely to change the
# domain or rotate files (the admin token is NOT rotated on re-run).
set -euo pipefail

DOMAIN=""
BASE_URL="https://raw.githubusercontent.com/ItsNotAILABS/KILN/main/relay"
SSH_PUBKEY=""
ADMIN_PORT="19191"
PROXY_PORT="8080"
DO_UFW=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --ssh-pubkey) SSH_PUBKEY="$2"; shift 2 ;;
    --admin-port) ADMIN_PORT="$2"; shift 2 ;;
    --proxy-port) PROXY_PORT="$2"; shift 2 ;;
    --no-ufw) DO_UFW=0; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "error: --domain is required, e.g. --domain preview.example.com" >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
  echo "error: run as root (e.g. pipe into 'sudo bash')" >&2
  exit 2
fi

say() { echo "==> $*"; }

# ---------------------------------------------------------------- packages
say "installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg openssl ufw > /dev/null

if ! command -v node > /dev/null 2>&1; then
  say "installing Node 22 (nodesource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null
  apt-get install -y -qq nodejs > /dev/null
fi
say "node $(node --version)"

if ! command -v caddy > /dev/null 2>&1; then
  say "installing Caddy (official apt repo)"
  install -m 0755 -d /etc/apt/keyrings
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  apt-get update -qq
  apt-get install -y -qq caddy > /dev/null
fi
say "$(caddy version | head -1)"

# ---------------------------------------------------------------- relay files
say "installing relay to /opt/kiln-relay"
mkdir -p /opt/kiln-relay /etc/kiln-relay /var/lib/kiln-relay
ADMIN_MJS="/opt/kiln-relay/admin.mjs"
GOT_ADMIN=0
if [[ -n "$BASE_URL" ]]; then
  if curl -fsSL --max-time 30 "$BASE_URL/admin.mjs" -o "$ADMIN_MJS"; then
    GOT_ADMIN=1
  else
    echo "warning: could not fetch $BASE_URL/admin.mjs" >&2
  fi
fi
if [[ $GOT_ADMIN -eq 0 ]]; then
  # Sibling mode: someone copied the whole relay/ dir over and runs ./setup.sh
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$SCRIPT_DIR/admin.mjs" ]]; then
    cp "$SCRIPT_DIR/admin.mjs" "$ADMIN_MJS"
    GOT_ADMIN=1
  fi
fi
if [[ $GOT_ADMIN -eq 0 ]]; then
  echo "error: could not get admin.mjs — pass --base-url <url> pointing at the relay/ dir, or run setup.sh from a copy of relay/" >&2
  exit 1
fi
node --check "$ADMIN_MJS"

# ---------------------------------------------------------------- admin token
TOKEN_FILE="/etc/kiln-relay/admin.token"
if [[ -f "$TOKEN_FILE" ]]; then
  say "keeping existing admin token"
else
  say "generating admin token"
  openssl rand -hex 32 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
ADMIN_TOKEN="$(cat "$TOKEN_FILE")"

# ---------------------------------------------------------------- ssh access for the tunnel
# The KILN daemon opens `ssh -N -R ... user@host` from the inside out, so the
# VPS needs the tunnel key in authorized_keys. Remote -R binds are
# 127.0.0.1-only (no GatewayPorts), so the tunnel user only ever reaches the
# local admin + proxy.
GENERATED_KEY=0
if [[ -n "$SSH_PUBKEY" ]]; then
  say "installing provided ssh public key"
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
  grep -qxF "$SSH_PUBKEY" /root/.ssh/authorized_keys || echo "$SSH_PUBKEY" >> /root/.ssh/authorized_keys
else
  if [[ ! -f /etc/kiln-relay/tunnel_key ]]; then
    say "generating tunnel keypair"
    ssh-keygen -t ed25519 -f /etc/kiln-relay/tunnel_key -N "" -C "kiln-preview-tunnel" -q
    chmod 600 /etc/kiln-relay/tunnel_key
  fi
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
  PUB="$(cat /etc/kiln-relay/tunnel_key.pub)"
  grep -qxF "$PUB" /root/.ssh/authorized_keys || echo "$PUB" >> /root/.ssh/authorized_keys
  GENERATED_KEY=1
fi

# ---------------------------------------------------------------- systemd
say "installing systemd unit"
cat > /etc/systemd/system/kiln-relay-admin.service <<EOF
[Unit]
Description=KILN public-preview relay admin + proxy
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/kiln-relay
Environment=DOMAIN=$DOMAIN
Environment=RELAY_PORT=$ADMIN_PORT
Environment=PROXY_PORT=$PROXY_PORT
Environment=TOKEN_FILE=$TOKEN_FILE
Environment=REGISTRY_FILE=/var/lib/kiln-relay/registry.json
ExecStart=/usr/bin/node /opt/kiln-relay/admin.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now kiln-relay-admin > /dev/null
sleep 2
if ! systemctl is-active --quiet kiln-relay-admin; then
  echo "error: kiln-relay-admin failed to start — see: journalctl -u kiln-relay-admin" >&2
  exit 1
fi
say "relay admin running on 127.0.0.1:$ADMIN_PORT (proxy on 127.0.0.1:$PROXY_PORT)"

# ---------------------------------------------------------------- caddy
say "configuring Caddy (on-demand TLS for *.$DOMAIN)"
if [[ -f /etc/caddy/Caddyfile && ! -f /etc/caddy/Caddyfile.bak ]]; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak
  echo "backed up existing Caddyfile to /etc/caddy/Caddyfile.bak"
fi
cat > /etc/caddy/Caddyfile <<EOF
# KILN public previews — managed by relay/setup.sh (backup: Caddyfile.bak)
{
	on_demand_tls {
		ask http://127.0.0.1:$ADMIN_PORT/ask
		interval 2m
		burst 5
	}
}

https://*.$DOMAIN {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:$PROXY_PORT
}
EOF
systemctl reload caddy
say "caddy reloaded"

# ---------------------------------------------------------------- firewall
if [[ $DO_UFW -eq 1 ]]; then
  say "opening 80/443 in ufw"
  ufw allow OpenSSH > /dev/null
  ufw allow 80/tcp > /dev/null
  ufw allow 443/tcp > /dev/null
  if ! ufw status | grep -q "Status: active"; then
    ufw --force enable > /dev/null
  fi
fi

# ---------------------------------------------------------------- done: print the goods
VPS_IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"

cat <<EOF

================================================================
 KILN preview relay is live on this VPS.
================================================================

1) Add this to your KILN machine's <stateDir>/config.json
   (usually ~/.kiln-swarm/config.json) as the "preview" key:

"preview": {
  "mode": "ssh",
  "relay": "ssh://root@${VPS_IP}",
  "key": "/home/hatch/.ssh/kiln_preview",
  "domain": "${DOMAIN}",
  "portRange": "19000-19099",
  "relayAdminUrl": "http://127.0.0.1:${ADMIN_PORT}",
  "relayAdminToken": "${ADMIN_TOKEN}"
}

   Then restart the swarm daemon so it picks up the config.

2) The tunnel private key lives on the KILN machine at the "key" path
   above (chmod 600). Its public half is already in this VPS's
   /root/.ssh/authorized_keys.
EOF

if [[ $GENERATED_KEY -eq 1 ]]; then
  cat <<EOF

   !!! SAVE THIS PRIVATE KEY on your KILN machine as the "key" file !!!
   (we generated it because you didn't pass --ssh-pubkey)

$(cat /etc/kiln-relay/tunnel_key)

   After saving, DELETE this terminal scrollback line's worth of worry by
   knowing the key file on the VPS (/etc/kiln-relay/tunnel_key) is root-only.
EOF
else
  echo
  echo "   (You passed --ssh-pubkey, so your existing private key stays where it is.)"
fi

cat <<EOF

3) SEND THIS ONE LINE BACK TO YOUR AGENT:
   relay=root@${VPS_IP} key_path=/home/hatch/.ssh/kiln_preview domain=${DOMAIN}

   The agent needs the relay ssh address and where the private key lives
   on the KILN machine to finish wiring previews.

Checks:  systemctl status kiln-relay-admin | caddy validate --config /etc/caddy/Caddyfile
Logs:    journalctl -u kiln-relay-admin -f
================================================================
EOF
