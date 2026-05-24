#!/usr/bin/env bash
#
# Build sikemux for macOS with the Liquid Glass app icon.
#
# Pipeline:
#   1. scripts/icons.sh — compiles sikemux.icon → Assets.car + legacy .icns
#      (idempotent; no-op when the .icon source hasn't changed).
#   2. pnpm tauri build — Tauri auto-copies Assets.car into the .app's
#      Resources/ via bundle.resources in tauri.conf.json.
#   3. Patch the bundled Info.plist with CFBundleIconName so macOS Big
#      Sur+ loads the Liquid Glass icon from Assets.car. Legacy icon.icns
#      stays in Resources/ as a fallback for older macOS.
#
# Args are forwarded to `pnpm tauri build`:
#   ./scripts/build-mac.sh --target universal-apple-darwin
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"
APP_NAME="sikemux"

# ---- 1. ensure icons are current ----
"$ROOT/scripts/icons.sh"

# ---- 2. tauri build (beforeBuildCommand re-runs icons.sh — idempotent) ----
echo "→ pnpm tauri build $*"
pnpm tauri build "$@"

# ---- 3. patch the bundled .app ----
APP_PATH="$(/usr/bin/find src-tauri/target -maxdepth 6 -type d -name "${APP_NAME}.app" -path "*/bundle/macos/*" -print 2>/dev/null \
  | xargs -I{} stat -f '%m %N' {} \
  | sort -rn \
  | head -1 \
  | cut -d' ' -f2-)"

if [[ -z "${APP_PATH:-}" || ! -d "$APP_PATH" ]]; then
  echo "Couldn't locate built .app under src-tauri/target/" >&2
  exit 1
fi
echo "→ Patching $APP_PATH"

# Assets.car: belt-and-braces — bundle.resources should have copied it.
if [[ ! -f "$APP_PATH/Contents/Resources/Assets.car" ]]; then
  cp "$ROOT/src-tauri/icons/build/Assets.car" "$APP_PATH/Contents/Resources/Assets.car"
  echo "  ✓ Assets.car copied (bundle.resources didn't)"
fi

PLIST="$APP_PATH/Contents/Info.plist"
if /usr/libexec/PlistBuddy -c "Print :CFBundleIconName" "$PLIST" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconName $APP_NAME" "$PLIST"
else
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconName string $APP_NAME" "$PLIST"
fi
echo "  ✓ CFBundleIconName=$APP_NAME injected"

echo ""
echo "Liquid Glass icon installed."
echo "Built: $APP_PATH"
