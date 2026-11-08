#!/usr/bin/env bash
# Smoke-test a Leoposta container image with docker or podman.
# Usage: scripts/container-smoke.sh [IMAGE]   (default: ghcr.io/leonardschwier/leoposta:latest)
set -euo pipefail

IMAGE="${1:-ghcr.io/leonardschwier/leoposta:latest}"
ENGINE="${CONTAINER_ENGINE:-$(command -v docker || command -v podman)}"
NAME="leoposta-smoke-$$"
PORT="${SMOKE_PORT:-13001}"
TOKEN="smoke-token-0123456789"
fail() { echo "FAIL: $*" >&2; "$ENGINE" logs "$NAME" >&2 || true; exit 1; }
trap '"$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

"$ENGINE" run -d --name "$NAME" -p "127.0.0.1:$PORT:3001" -e LEOPOSTA_TOKEN="$TOKEN" "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done

[ "$(curl -fsS "http://127.0.0.1:$PORT/api/health")" = '{"ok":true}' ] || fail "/api/health"
echo "ok: /api/health returns {\"ok\":true}"

curl -fsS "http://127.0.0.1:$PORT/" | grep -qi '<title>' || fail "frontend index not served"
echo "ok: / serves the frontend"

code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/messages")"
[ "$code" = 401 ] || fail "/api/messages without token returned $code, expected 401"
echo "ok: API rejects requests without a token (401)"

js="$(curl -fsS "http://127.0.0.1:$PORT/" | grep -o '/assets/index-[^"]*\.js' | head -1)"
bundle="$(curl -fsS "http://127.0.0.1:$PORT$js")"
grep -q '__LEOPOSTA_TOKEN__' <<<"$bundle" && fail "token placeholder still present in the frontend"
grep -q "$TOKEN" <<<"$bundle" || fail "runtime token not injected into the frontend"
echo "ok: runtime token injected into the frontend, placeholder gone"

uid="$("$ENGINE" exec "$NAME" id -u)"
[ "$uid" != 0 ] || fail "container runs as root"
echo "ok: runs as non-root (uid $uid)"

for _ in $(seq 1 20); do
  status="$("$ENGINE" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NAME" 2>/dev/null || true)"
  [ "$status" = healthy ] && { echo "ok: healthcheck reports healthy"; exit 0; }
  [ -z "$status" ] && { echo "skip: engine does not report health status"; exit 0; }
  sleep 3
done
fail "healthcheck never became healthy (last status: $status)"
