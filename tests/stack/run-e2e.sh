#!/usr/bin/env bash
# Full real-stack e2e run: build both frontends, then for each IMAP layout
# bring the stack up, run Playwright, and tear it down.
#
#   npm run test:e2e:real                 # both layouts
#   E2E_LAYOUTS=slash npm run test:e2e:real -- tests/e2e-real/folders.spec.ts
#   KEEP_STACK=1 ...                      # leave the stack running afterwards
set -euo pipefail
cd "$(dirname "$0")/../.."

TOKEN=e2e-real-token
VITE_LEOPOSTA_TOKEN=$TOKEN npx vite build --outDir dist-e2e --emptyOutDir >/dev/null
LEOPOSTA_DESKTOP=1 VITE_LEOPOSTA_TOKEN=injected-by-desktop-shell \
  npx vite build --outDir dist-e2e-desktop --emptyOutDir >/dev/null
echo "built dist-e2e (pwa) and dist-e2e-desktop (desktop)"

status=0
for layout in ${E2E_LAYOUTS:-slash dot}; do
  tests/stack/stack.sh up "$layout"
  echo "=== e2e (layout: $layout)"
  E2E_LAYOUT=$layout npx playwright test -c playwright.real.config.ts "$@" || status=1
  [[ -n "${KEEP_STACK:-}" ]] || tests/stack/stack.sh down
done
exit $status
