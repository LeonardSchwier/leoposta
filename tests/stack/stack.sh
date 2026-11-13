#!/usr/bin/env bash
# Real mail stack for the e2e suite: Dovecot (IMAP), Radicale (CalDAV/CardDAV)
# in containers, plus the node SMTP sink. Works with docker or podman.
#
#   tests/stack/stack.sh up [slash|dot]   # start (default layout: slash)
#   tests/stack/stack.sh down             # stop and remove everything
#
# Ports (127.0.0.1): IMAP 3143, SMTP 3587, DAV 5233. Any user, password "pass".
set -euo pipefail
cd "$(dirname "$0")/../.."

ENGINE="${CONTAINER_ENGINE:-$(command -v docker >/dev/null && echo docker || echo podman)}"
IMAP_PORT="${IMAP_PORT:-3143}"
SMTP_PORT="${SMTP_PORT:-3587}"
DAV_PORT="${DAV_PORT:-5233}"
STATE=".e2e-real"
DOVECOT_IMAGE="${DOVECOT_IMAGE:-docker.io/dovecot/dovecot:latest}"
RADICALE_IMAGE="${RADICALE_IMAGE:-docker.io/tomsquest/docker-radicale:latest}"

wait_tcp() { # host port what
  for _ in $(seq 1 60); do
    if (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  echo "error: $3 did not come up on $1:$2" >&2; return 1
}

down() {
  "$ENGINE" rm -f leoposta-e2e-dovecot leoposta-e2e-radicale >/dev/null 2>&1 || true
  if [[ -f "$STATE/smtp.pid" ]]; then kill "$(cat "$STATE/smtp.pid")" 2>/dev/null || true; rm -f "$STATE/smtp.pid"; fi
}

up() {
  local layout="${1:-slash}"
  down
  rm -rf "$STATE"; mkdir -p "$STATE"
  "$ENGINE" run -d --name leoposta-e2e-dovecot \
    -e USER_PASSWORD=pass \
    -p "127.0.0.1:$IMAP_PORT:31143" \
    -v "$PWD/tests/stack/dovecot-$layout.conf:/etc/dovecot/conf.d/zz-leoposta.conf:ro,Z" \
    "$DOVECOT_IMAGE" >/dev/null
  "$ENGINE" run -d --name leoposta-e2e-radicale \
    -p "127.0.0.1:$DAV_PORT:5232" \
    -v "$PWD/tests/stack/radicale.conf:/config/config:ro,Z" \
    "$RADICALE_IMAGE" >/dev/null
  wait_tcp 127.0.0.1 "$IMAP_PORT" "Dovecot"
  wait_tcp 127.0.0.1 "$DAV_PORT" "Radicale"
  local inbox=INBOX
  IMAP_PORT="$IMAP_PORT" SMTP_PORT="$SMTP_PORT" SMTP_LOG="$STATE/smtp.jsonl" STACK_INBOX="$inbox" \
    nohup node tests/stack/smtp-sink.mjs >"$STATE/smtp.log" 2>&1 &
  echo $! >"$STATE/smtp.pid"
  wait_tcp 127.0.0.1 "$SMTP_PORT" "SMTP sink"
  echo "$layout" >"$STATE/layout"
  echo "stack up ($layout): imap :$IMAP_PORT smtp :$SMTP_PORT dav :$DAV_PORT"
}

case "${1:-}" in
  up) up "${2:-slash}" ;;
  down) down; echo "stack down" ;;
  *) echo "usage: $0 up [slash|dot] | down" >&2; exit 2 ;;
esac
