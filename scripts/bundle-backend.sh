#!/usr/bin/env bash
# Regenerates the desktop backend bundle that Tauri ships as a resource.
# Layout produced:
#   src-tauri/resources/backend/
#     node                  # distro node (dynamically linked; see deb deps)
#     node_modules/         # production deps (express, imapflow, mailparser, ...)
#     server/index.js, server/lib/, server/routes/
#     dist/                 # static frontend (`npm run build:desktop`)
#
# The Tauri shell spawns this backend on a random free loopback port, then
# navigates the WebView to http://127.0.0.1:<port>. No port is ever
# hardcoded at runtime, so the app never collides with another local process
# that happens to be on a well-known port.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT"
OUT="$ROOT/src-tauri/resources/backend"

# Wipe any previous bundle.
rm -rf "$OUT"
mkdir -p "$OUT/server"

# Pick the node binary. Prefer the system one (it matches the libraries the
# deb package declares). Fall back to a custom bundled copy at $NODE_BIN.
if [[ -n "${NODE_BIN:-}" ]]; then
  NODE_BIN_PATH="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN_PATH="$(command -v node)"
else
  echo "error: node not found on PATH (and NODE_BIN not set)" >&2
  exit 1
fi

cp -L "$NODE_BIN_PATH" "$OUT/node"
chmod 755 "$OUT/node"
echo "bundled node: $NODE_BIN_PATH -> $OUT/node"
"$OUT/node" -v

# Copy Node's own runtime libraries (libnode, libuv, brotli, cares, sqlite,
# brotlicommon — the ones Fedora ships *outside* the `node-22` launcher) so
# the bundle works on a box without the `libnode.so.127` package installed.
# We deliberately do NOT bundle libc/libm/libpthread/glibc — those are
# ABI-sensitive and bundling them is unsafe. Only ship "the engine".
NODE_LIBS=(libnode.so.127 libuv.so.1 libbrotlidec.so.1 libbrotlienc.so.1 \
           libbrotlicommon.so.1 libcares.so.2 libsqlite3.so.0 \
           libz.so.1 libssl.so.3 libcrypto.so.3)
mkdir -p "$OUT/libs"
shipped=()
for name in "${NODE_LIBS[@]}"; do
  # Resolve against the live `node` binary so we ship the exact sonames it
  # needs (avoids guessing the versioned name per-distro).
  # ldd: "<name> => <path> (addr)"; ldconfig -p: "<name> (cpu) => <path>"
  base_name=$(ldd "$OUT/node" 2>/dev/null | awk -v n="$name" '$1==n{print $1; exit}')
  [[ -z "$base_name" ]] && base_name="$name"
  so_path=$(ldd "$OUT/node" 2>/dev/null | awk -v n="$name" '$1==n{print $3; exit}')
  [[ -z "$so_path" ]] && so_path=$(ldconfig -p 2>/dev/null | awk -v n="$base_name" '$1==n{print $NF; exit}')
  [[ -z "$so_path" ]] && so_path=$(ls /lib64/$base_name /usr/lib64/$base_name /lib/x86_64-linux-gnu/$base_name /usr/lib/x86_64-linux-gnu/$base_name 2>/dev/null | head -1)
  if [[ -n "$so_path" && -f "$so_path" ]]; then
    cp -L "$so_path" "$OUT/libs/"
    shipped+=("$(basename "$so_path")")
  else
    echo "  - $name (not found; app will fall back to the system copy)"
  fi
done
echo "bundled engine libs: ${shipped[*]:-none} ("$(du -sh "$OUT/libs" 2>/dev/null | awk '{print $1}')")"

# Install only the production dependency closure into the bundle, in a
# scratch directory — NOT a copy of the dev node_modules. The dev tree also
# holds devDependencies (vite, and everything it pulls in transitively,
# including rollup), none of which server/index.js ever imports. It
# previously got blindly `cp -R`'d in whole, which is how
# @rollup/rollup-linux-x64-musl ended up in a desktop bundle on a glibc
# machine: rollup ships one optional native binary per platform+libc, npm's
# resolution for this lockfile pulled in both the glibc and musl variants
# even though only the glibc one is ever used, and linuxdeploy's ELF
# dependency scanner throws an unhandled exception when it tries to resolve
# the musl build's foreign /lib/ld-musl-x86_64.so.1 interpreter — silently
# aborting the whole AppImage bundle step. A clean `npm ci --omit=dev` never
# installs vite/rollup at all, so the problem can't recur even if a future
# optional-native package has the same glibc/musl split.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
cp "$SRC/package.json" "$SRC/package-lock.json" "$SCRATCH/"
(cd "$SCRATCH" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts >/dev/null)
mv "$SCRATCH/node_modules" "$OUT/node_modules"
echo "bundled production node_modules ($(du -sh "$OUT/node_modules" | awk '{print $1}'))"

# Copy the server code. index.js imports from lib/ and routes/ (19 files
# between them) -- copying index.js alone left those unresolved at runtime
# (`ERR_MODULE_NOT_FOUND: .../server/lib/auth.js`), so the desktop bundle
# could never have started. server/fixtures/ (test-only IMAP fixtures) is
# a sibling of lib/ and routes/, not copied here, so it never needs
# excluding; *.test.js files living inside lib/ and routes/ do.
rsync -a --exclude='*.test.js' \
  "$SRC/server/index.js" "$SRC/server/lib" "$SRC/server/routes" "$OUT/server/"

# Deliberately NOT shipped: server/.dev-token and the PGP key/passphrase
# files. The desktop shell hands the backend a fresh per-launch token via
# LEOPOSTA_TOKEN and points LEOPOSTA_DATA_DIR at the user's app-data dir,
# where PGP keys are read from — so bundling them would only leak secrets
# into every package built on this machine.

# Static frontend, built without a baked-in API token (see build:desktop in
# package.json) into dist-desktop/, so it never clobbers the dist/ that the
# browser/PWA server in the same checkout is serving.
(cd "$SRC" && npm run build:desktop >/dev/null)
cp -R "$SRC/dist-desktop" "$OUT/dist"

echo
echo "bundle size:"
du -sh "$OUT" 2>/dev/null | awk 'BEGIN{OFS="\t"} {printf "  %s\n", $0}'
du -sh "$OUT"/* 2>/dev/null
echo
echo "ok: $OUT"
