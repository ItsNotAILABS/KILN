#!/usr/bin/env bash
# Re-vendor the generic doctor core from the doctor repo into KILN.
# The doctor repo (ItsNotAILABS/doctor) is the source of truth; this only
# copies core/ — never edit swarm/lib/doctor-core/*.mjs by hand.
set -euo pipefail
DOCTOR_REPO="${DOCTOR_REPO:-$HOME/workspace/repos/doctor}"
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ ! -d "$DOCTOR_REPO/core" ]; then
  echo "doctor repo not found at $DOCTOR_REPO (override with DOCTOR_REPO=...)" >&2
  exit 1
fi
cp "$DOCTOR_REPO"/core/*.mjs "$HERE"/
SHA="$(cd "$DOCTOR_REPO" && git rev-parse HEAD)"
cat > "$HERE/VERSION" <<EOF
# Vendored snapshot of the generic doctor core.
# Source of truth: ItsNotAILABS/doctor (~/workspace/repos/doctor), core/
# This copy is a snapshot — do not edit here. Re-sync with:
#   bash swarm/lib/doctor-core/sync-from-doctor.sh
DOCTOR_REPO_COMMIT=$SHA
VENDORED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
echo "vendored doctor core @ $SHA"
