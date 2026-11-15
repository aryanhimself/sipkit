#!/usr/bin/env bash
# Opt-in: run the shared engine contract (V1-TEST-02) against NativeSipEngine with two
# baresip sidecar containers registered as the plain-SIP UDP endpoints 2001 / 2002.
#
#   pnpm --filter sipkit-engine-native test:contract [-- vitest args]
#
# Needs Docker and a running dev PBX on the sipkit-dev_voip network
# (cd infra/asterisk && docker compose up -d). Environment:
#   NATIVE_PBX               SIP server host:port            (default 172.28.0.10:5060, the shared dev PBX)
#   NATIVE_DOCKER_NETWORK    network shared with the PBX     (default sipkit-dev_voip)
#   NATIVE_SIDECAR_IMAGE     sidecar image tag               (default sipkit/baresip-sidecar:4.12)
#   NATIVE_REBUILD=1         rebuild the image even if it exists
#   NATIVE_SIDECAR_MODE      memory (default) | stdio (spawns dist/node/cli.js; builds the package first)
#   NATIVE_CONTAINER_PREFIX  container name prefix           (default sipkit-native-sidecar)
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${NATIVE_SIDECAR_IMAGE:-sipkit/baresip-sidecar:4.12}"
NETWORK="${NATIVE_DOCKER_NETWORK:-sipkit-dev_voip}"
PBX="${NATIVE_PBX:-172.28.0.10:5060}"
PREFIX="${NATIVE_CONTAINER_PREFIX:-sipkit-native-sidecar}"
MODE="${NATIVE_SIDECAR_MODE:-memory}"

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "Docker network $NETWORK not found. Start the dev PBX first: (cd infra/asterisk && docker compose up -d)" >&2
  exit 1
fi

if [[ "${NATIVE_REBUILD:-}" == "1" ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Building $IMAGE (libre + baresip from source; first build takes a few minutes)..."
  docker build -t "$IMAGE" sidecar
fi

cleanup() { docker rm -f "$PREFIX-a" "$PREFIX-b" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# ctrl_tcp is published on a random loopback port; SIP/RTP stay on the Docker network.
docker run -d --name "$PREFIX-a" --network "$NETWORK" -p 127.0.0.1::4444 "$IMAGE" >/dev/null
docker run -d --name "$PREFIX-b" --network "$NETWORK" -p 127.0.0.1::4444 "$IMAGE" >/dev/null
CTRL_A="$(docker port "$PREFIX-a" 4444/tcp | head -n1)"
CTRL_B="$(docker port "$PREFIX-b" 4444/tcp | head -n1)"
echo "sidecar a (2001): ctrl_tcp $CTRL_A  |  sidecar b (2002): ctrl_tcp $CTRL_B  |  PBX $PBX  |  mode $MODE"

if [[ "$MODE" == "stdio" ]]; then
  pnpm run build
fi

NATIVE_PBX="$PBX" NATIVE_SIDECAR_A="$CTRL_A" NATIVE_SIDECAR_B="$CTRL_B" NATIVE_SIDECAR_MODE="$MODE" \
  pnpm exec vitest run -c vitest.contract.config.ts "$@"
