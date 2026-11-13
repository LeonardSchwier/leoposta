#!/usr/bin/env bash
# Pulls the latest main, rebuilds, and restarts the live leoposta.service —
# but only if the new commit's checks pass. Rolls back on any failure so the
# running service never gets left on broken code. Afterwards the per-user
# desktop app (scripts/install-desktop.sh) is rebuilt whenever its installed
# build doesn't match HEAD — including retrying a previously failed build.
# Run daily by ~/.config/systemd/user/leoposta-update.timer.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

update_desktop() {
  local want have
  want="$(git rev-parse --short=12 HEAD)"
  have="$(basename "$(readlink "$HOME/.local/lib/leoposta/current" 2>/dev/null)" 2>/dev/null || true)"
  if [ "$have" = "$want" ]; then
    echo "leoposta desktop: already at $want"
    return 0
  fi
  echo "leoposta desktop: $have -> $want"
  # A failed desktop build leaves the installed version untouched (it is only
  # swapped in after a complete build) and must not roll back the server.
  if ! bash scripts/install-desktop.sh; then
    echo "leoposta desktop: build failed, keeping $have" >&2
    return 1
  fi
}

OLD_HEAD=$(git rev-parse HEAD)
git fetch github main --quiet

NEW_HEAD=$(git rev-parse github/main)
if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
  echo "leoposta: already up to date ($OLD_HEAD)"
  update_desktop
  exit $?
fi

echo "leoposta: updating $OLD_HEAD -> $NEW_HEAD"
git merge --ff-only github/main

rollback() {
  echo "leoposta: update failed, rolling back to $OLD_HEAD" >&2
  git reset --hard "$OLD_HEAD"
  npm ci --no-audit --no-fund >/dev/null 2>&1 || true
  npm run build >/dev/null 2>&1 || true
  systemctl --user restart leoposta.service
  exit 1
}
trap rollback ERR

npm ci --no-audit --no-fund
npm run typecheck
npm run test:server
npm run build

systemctl --user restart leoposta.service
sleep 2
curl -sf http://127.0.0.1:3001/api/health >/dev/null

trap - ERR
echo "leoposta: updated to $NEW_HEAD and healthy"

update_desktop
