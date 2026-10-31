#!/usr/bin/env bash
# Regenerates the desktop backend bundle that Tauri ships as a resource.
# Layout produced:
#   src-tauri/resources/backend/
#     node                  # distro node (dynamically linked; see deb deps)
#     node_modules/         # production deps (express, imapflow, mailparser, ...)
#     server/index.js
#     server/pgp_private.asc / pgp_publics.asc / pgp_passphrase.txt
#     dist/                 # static frontend (vite build output)
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

# Copy runtime node_modules. Use `npm ls --omit=dev --parseable --all` to
# only take the runtime closure, OR copy the whole node_modules (simpler,
# the bundle is gitignored).
cp -R "$SRC/node_modules" "$OUT/node_modules"
# Strip any dev-only noise to keep the bundle tighter (best-effort, not fatal).
rm -rf "$OUT/node_modules/.bin" 2>/dev/null || true

# Copy the server code.
cp "$SRC/server/index.js" "$OUT/server/index.js"

# Copy PGP keys (optional at bundle time — the user can also add them via
# Settings after first launch, but shipping them makes an already-set-up box
# work out of the box).
for f in pgp_private.asc pgp_publics.asc pgp_passphrase.txt; do
  if [[ -f "$SRC/server/$f" ]]; then
    cp "$SRC/server/$f" "$OUT/server/$f"
  else
    echo "warn: $SRC/server/$f not present; PGP will need to be configured after launch" >&2
  fi
done
# Secret files must be 600; public keys are 644.
[[ -f "$OUT/server/pgp_private.asc"    ]] && chmod 600 "$OUT/server/pgp_private.asc"
[[ -f "$OUT/server/pgp_passphrase.txt" ]] && chmod 600 "$OUT/server/pgp_passphrase.txt"
[[ -f "$OUT/server/pgp_publics.asc"   ]] && chmod 644 "$OUT/server/pgp_publics.asc"

# Static frontend.
[[ -d "$SRC/dist" ]] || { echo "error: dist/ not present — run `npm run build` first (or rely on Tauri's beforeBuildCommand which runs `vite build`)" >&2; exit 1; }
cp -R "$SRC/dist" "$OUT/dist"

echo
echo "bundle size:"
du -sh "$OUT" 2>/dev/null | awk 'BEGIN{OFS="\t"} {printf "  %s\n", $0}'
du -sh "$OUT"/* 2>/dev/null
echo
echo "ok: $OUT"
