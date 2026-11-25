#!/usr/bin/env bash
# Build the KILN virtual computer image from the pins in versions.env.
#   ./build.sh [tag]        default tag: kiln-vc:<KILN_VC_IMAGE_VERSION>
# DOCKER=podman ./build.sh also works.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
docker="${DOCKER:-docker}"
args=()
while IFS='=' read -r k v; do
  [[ -z "$k" || "$k" == \#* ]] && continue
  args+=(--build-arg "$k=$v")
  [[ "$k" == KILN_VC_IMAGE_VERSION ]] && ver="$v"
done < "$here/versions.env"
tag="${1:-kiln-vc:${ver}}"
exec "$docker" build "${args[@]}" -t "$tag" "$here"
