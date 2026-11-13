#!/usr/bin/env bash
# Builds the Leoposta desktop app from this checkout and installs it for the
# current user only — no root, no package manager:
#
#   ~/.local/lib/leoposta/<commit>/bin/leoposta
#   ~/.local/lib/leoposta/<commit>/lib/Leoposta/backend/   bundled node + server
#     (Tauri resolves resources at <exe dir>/../lib/<productName>, so each
#      version is a tiny prefix of its own)
#   ~/.local/lib/leoposta/current          -> <commit>   (atomic symlink swap)
#   ~/.local/bin/leoposta                  -> current/bin/leoposta
#   ~/.local/share/applications/org.schwier.leoposta.desktop
#   ~/.local/share/icons/hicolor/<N>x<N>/apps/org.schwier.leoposta.png
#
# Each build lands in its own versioned directory, so a running instance keeps
# its own binary and backend files intact while a newer one is installed next
# to it. The two most recent versions are kept.
#
# Usage: scripts/install-desktop.sh [--pin]   (--pin also adds it to the dock)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"

APP_ID="org.schwier.leoposta"
LIB="$HOME/.local/lib/leoposta"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"

PIN=0
[[ "${1:-}" == "--pin" ]] && PIN=1

REV="$(git rev-parse --short=12 HEAD)"
git diff --quiet HEAD -- . ':!package-lock.json' || REV="$REV-dirty"

# --no-bundle: we only need the binary plus the resources tauri-build copies
# next to it (target/release/backend); no RPM/AppImage packaging step.
npx tauri build --no-bundle
REL="$ROOT/src-tauri/target/release"
[[ -x "$REL/leoposta" && -f "$REL/backend/server/index.js" ]] || {
  echo "error: build output incomplete in $REL" >&2; exit 1; }

DEST="$LIB/$REV"
rm -rf "$DEST.tmp"
mkdir -p "$DEST.tmp"
PRODUCT="$(node -p "require('./src-tauri/tauri.conf.json').productName")"
mkdir -p "$DEST.tmp/bin" "$DEST.tmp/lib/$PRODUCT"
cp "$REL/leoposta" "$DEST.tmp/bin/"
cp -R "$REL/backend" "$DEST.tmp/lib/$PRODUCT/backend"
rm -rf "$DEST"
mv "$DEST.tmp" "$DEST"

ln -sfn "$REV" "$LIB/current.new" && mv -T "$LIB/current.new" "$LIB/current"
mkdir -p "$BIN"
ln -sfn "$LIB/current/bin/leoposta" "$BIN/leoposta"

# Icons: one padded master (tile fills 422/512, same footprint as the other
# GNOME tile icons), downscaled per size so small sizes stay crisp.
MASTER="$ROOT/src-tauri/icons/icon.png"
for s in 16 24 32 48 64 128 256 512; do
  mkdir -p "$ICONS/${s}x${s}/apps"
  if command -v magick >/dev/null; then
    magick "$MASTER" -filter Lanczos -resize "${s}x${s}" "$ICONS/${s}x${s}/apps/$APP_ID.png"
  elif [[ $s == 512 ]]; then
    cp "$MASTER" "$ICONS/512x512/apps/$APP_ID.png"
  fi
done

mkdir -p "$APPS"
cat > "$APPS/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Leoposta
GenericName=Mail Client
Comment=Local-first mail client
Exec=$LIB/current/bin/leoposta
TryExec=$LIB/current/bin/leoposta
Icon=$APP_ID
Terminal=false
Categories=Network;Email;
Keywords=mail;email;imap;smtp;
StartupNotify=true
StartupWMClass=leoposta
EOF

update-desktop-database "$APPS" 2>/dev/null || true
gtk-update-icon-cache -f -t "$ICONS" 2>/dev/null || true

if [[ $PIN == 1 ]] && command -v gsettings >/dev/null; then
  favs="$(gsettings get org.gnome.shell favorite-apps)"
  if [[ "$favs" != *"'$APP_ID.desktop'"* ]]; then
    gsettings set org.gnome.shell favorite-apps "${favs%]}, '$APP_ID.desktop']"
    echo "pinned to dock"
  fi
fi

# Keep the current and the previous version, drop older ones.
ls -1dt "$LIB"/*/ 2>/dev/null | grep -v '/current/$' | tail -n +3 | xargs -r rm -rf

echo "leoposta desktop: installed $REV -> $LIB/current"
