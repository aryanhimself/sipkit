#!/usr/bin/env bash
# Run the real-SIP e2e specs (e2e/sip/**) inside the official Playwright Linux
# image, attached to the dev PBX Docker network.
#
# Why Docker: on macOS, Chromium's fake *audio* capture hangs in getUserMedia
# (fake video works), so two-browser call tests can't run on the host. Linux
# Chromium (as in CI) works.
#
# Prereqs:
#   (cd infra/asterisk && ./scripts/gen-certs.sh && docker compose up -d --build)
#   pnpm install
# Usage (from repo root or anywhere):
#   apps/playground/scripts/e2e-sip-docker.sh [extra playwright args, e.g. -g "DTMF"]
#   E2E_NETEM=1 ... also runs the tc/netem packet-loss spec (e2e/sip/quality.spec.ts):
#   gives only the throwaway Playwright container NET_ADMIN and installs iproute2 in it.
#   E2E_VOICEMAIL_API_URL=http://<ip>:8090 (+ E2E_VOICEMAIL_TOKEN_SECRET or E2E_VOICEMAIL_TOKEN)
#   points e2e/sip/voicemail-list.spec.ts at a services/voicemail-api sharing the PBX spool.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PW_VERSION="$(node -p "require('$REPO/apps/playground/node_modules/@playwright/test/package.json').version")"
IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"
NETWORK="${E2E_SIP_NETWORK:-sipkit-dev_voip}"
# E2E_PORT lets several checkouts (git worktrees) each serve their own code.
PORT="${E2E_PORT:-5179}"
NETEM_ARGS=()
if [ "${E2E_NETEM:-}" = "1" ]; then NETEM_ARGS=(--cap-add=NET_ADMIN); fi

# One run at a time: every run shares the PBX's test extensions.
LOCK=/tmp/sipkit-sip-e2e.lock
for _ in $(seq 1 900); do mkdir "$LOCK" 2>/dev/null && break; sleep 2; done
[ -d "$LOCK" ] || { echo "Timed out waiting for $LOCK"; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# Playground dev server on the host, reachable from the container.
if ! curl -fsS -o /dev/null "http://localhost:${PORT}/"; then
  echo "Starting playground dev server on :${PORT}..."
  (cd "$REPO/apps/playground" && __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=host.docker.internal \
    pnpm exec vite --port "$PORT" --strictPort --host 0.0.0.0 >"/tmp/sipkit-playground-e2e-${PORT}.log" 2>&1 &)
  for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://localhost:${PORT}/" && break; sleep 1; done
fi

docker run --rm --init --ipc=host \
  --network "$NETWORK" \
  --add-host host.docker.internal:host-gateway \
  ${NETEM_ARGS[@]+"${NETEM_ARGS[@]}"} \
  -v "$REPO:/repo" -w /repo/apps/playground \
  -e CI="${CI:-}" \
  -e E2E_MODE=sip \
  -e E2E_BASE_URL="http://localhost:${PORT}" \
  -e E2E_SIP_WSS_URL="${E2E_SIP_WSS_URL:-wss://172.28.0.10:8089/ws}" \
  -e E2E_SIP_GATEWAY_WSS_URL="${E2E_SIP_GATEWAY_WSS_URL:-wss://172.28.0.11:8089/ws}" \
  -e E2E_SIP_PASSWORD="${E2E_SIP_PASSWORD:-sipkitdev123}" \
  -e E2E_DEBUG="${E2E_DEBUG:-}" \
  -e E2E_NETEM="${E2E_NETEM:-}" \
  -e E2E_VOICEMAIL_API_URL="${E2E_VOICEMAIL_API_URL:-}" \
  -e E2E_VOICEMAIL_TOKEN_SECRET="${E2E_VOICEMAIL_TOKEN_SECRET:-}" \
  -e E2E_VOICEMAIL_TOKEN="${E2E_VOICEMAIL_TOKEN:-}" \
  -e E2E_PUSH_URL="${E2E_PUSH_URL:-}" \
  -e E2E_PUSH_TOKEN="${E2E_PUSH_TOKEN:-}" \
  -e E2E_PUSH_SECRET="${E2E_PUSH_SECRET:-}" \
  "$IMAGE" \
  bash -c '
    if [ "$E2E_NETEM" = "1" ] && ! command -v tc >/dev/null; then
      (apt-get update -qq && apt-get install -y -qq iproute2) >/dev/null 2>&1 || echo "iproute2 install failed"
    fi
    # localhost is a secure context (getUserMedia); forward it to the host dev server.
    node -e "require(\"net\").createServer(c=>{const u=require(\"net\").connect('"$PORT"',\"host.docker.internal\");c.pipe(u).pipe(c);u.on(\"error\",()=>c.destroy());c.on(\"error\",()=>u.destroy())}).listen('"$PORT"',\"127.0.0.1\")" &
    sleep 0.5
    exec node node_modules/@playwright/test/cli.js test --project=sip "$@"
  ' _ "$@"
