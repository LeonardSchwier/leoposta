#!/bin/sh
# Start Leoposta in a container. Ensures one API token is shared by server and
# frontend: uses LEOPOSTA_TOKEN if set, otherwise generates a random one, then
# substitutes it for the build-time placeholder in the static frontend.
set -eu

if [ -z "${LEOPOSTA_TOKEN:-}" ]; then
  LEOPOSTA_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  export LEOPOSTA_TOKEN
fi

case "$LEOPOSTA_TOKEN" in
  *[!A-Za-z0-9._-]*) echo "LEOPOSTA_TOKEN may only contain A-Z a-z 0-9 . _ -" >&2; exit 1 ;;
esac

if grep -rlq '__LEOPOSTA_TOKEN__' /app/dist 2>/dev/null; then
  grep -rl '__LEOPOSTA_TOKEN__' /app/dist | while read -r f; do
    sed -i "s/__LEOPOSTA_TOKEN__/${LEOPOSTA_TOKEN}/g" "$f"
  done
fi

exec "$@"
