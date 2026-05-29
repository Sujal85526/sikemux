#!/usr/bin/env bash
#
# Cut a sikemux release.
#
# Pipeline:
#   1. Validate VERSION matches package.json + tauri.conf.json so the
#      bundled binary's CFBundleShortVersionString lines up with the
#      manifest's "version" field (the OTA updater compares these).
#   2. Ensure TAURI_SIGNING_PRIVATE_KEY is set in env — without it the
#      bundler skips signing and the updater later refuses the bundle.
#   3. Run build-mac.sh — produces .app, .dmg, .app.tar.gz, .sig under
#      src-tauri/target/release/bundle/.
#   4. Generate latest.json with the .sig contents inlined and the URL
#      pointing at the GitHub release tag we're about to create.
#   5. Stop. Print the exact `gh release create` command for review.
#      Pass --publish (or set RELEASE_PUBLISH=1) to actually upload.
#
# Usage:
#   scripts/release.sh 0.1.0 "initial release"
#   scripts/release.sh 0.1.1 "rundeck integration" --publish
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"

# ---- 0. load secrets from .env ----
# Gitignored .env holds TAURI_SIGNING_PRIVATE_KEY (+ optional _PASSWORD) so
# you don't have to export them every release. Anything already in the
# environment wins, so you can still override ad-hoc.
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

VERSION="${1:-}"
NOTES="${2:-}"
PUBLISH="${RELEASE_PUBLISH:-0}"
for arg in "${@:3}"; do
  [[ "$arg" == "--publish" ]] && PUBLISH=1
done

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> <notes> [--publish]" >&2
  echo "  e.g. $0 0.1.0 \"initial release\"" >&2
  exit 1
fi

# ---- 1. bump version everywhere ----
# Single source of truth = the VERSION arg. We rewrite package.json,
# tauri.conf.json, and Cargo.toml to match so the bundled binary's
# CFBundleShortVersionString lines up with the manifest "version" the OTA
# updater compares. Cargo.lock is refreshed by the build in step 3.
echo "→ Bumping version to $VERSION"
node -e "
  const fs = require('fs');
  for (const p of ['package.json', 'src-tauri/tauri.conf.json']) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.version = '$VERSION';
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  }
"
# Cargo.toml: only the first `version = ` under [package] (line ~3).
/usr/bin/sed -i '' -e "1,/^version = /s/^version = \".*\"/version = \"$VERSION\"/" \
  "$ROOT/src-tauri/Cargo.toml"

PKG_VER="$(node -p "require('./package.json').version")"
TAURI_VER="$(node -p "require('./src-tauri/tauri.conf.json').version")"
if [[ "$PKG_VER" != "$VERSION" || "$TAURI_VER" != "$VERSION" ]]; then
  echo "Version bump failed (package.json=$PKG_VER tauri.conf.json=$TAURI_VER)" >&2
  exit 1
fi

# ---- 2. signing key sanity ----
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  cat >&2 <<EOF
TAURI_SIGNING_PRIVATE_KEY not set (and no .env provided it).

Add it to $ROOT/.env:
  TAURI_SIGNING_PRIVATE_KEY=<contents of ~/.tauri/sikemux.key>
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD=    # empty if the key has no password

Then re-run.
EOF
  exit 1
fi
# Default the password to empty so the bundler doesn't block on a prompt
# when the key has no passphrase.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# ---- 3. build ----
echo "→ Building v$VERSION"
"$ROOT/scripts/build-mac.sh"

BUNDLE="src-tauri/target/release/bundle"
APP_NAME="$(node -p "require('./src-tauri/tauri.conf.json').productName")"
DMG="$(/usr/bin/find "$BUNDLE/dmg" -name "*.dmg" -newer "$ROOT/package.json" 2>/dev/null | head -1)"
TAR="$BUNDLE/macos/${APP_NAME}.app.tar.gz"
SIG="$BUNDLE/macos/${APP_NAME}.app.tar.gz.sig"

for f in "$DMG" "$TAR" "$SIG"; do
  if [[ -z "$f" || ! -f "$f" ]]; then
    echo "Missing artifact after build: $f" >&2
    exit 1
  fi
done

# ---- 4. latest.json ----
# The updater verifies the bundle by checking this signature against the
# embedded pubkey, so the sig contents must match the exact bytes of the
# tar.gz hosted at `url`.
MANIFEST="$ROOT/latest.json"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SIG_CONTENT="$(cat "$SIG")"
TAR_URL="https://github.com/nodelike/sikemux/releases/download/v$VERSION/${APP_NAME}.app.tar.gz"

# We only ship darwin-aarch64 for now (Apple Silicon). When colleagues
# need Intel, switch build-mac.sh to --target universal-apple-darwin and
# duplicate the entry under darwin-x86_64 with the same url + sig.
node -e "
  const fs = require('fs');
  const manifest = {
    version: '$VERSION',
    notes: ${NOTES:+'\"'$(printf %s "$NOTES" | sed 's/"/\\\\"/g')'\"' }${NOTES:-'\"\"'},
    pub_date: '$PUB_DATE',
    platforms: {
      'darwin-aarch64': {
        signature: \`$(printf '%s' "$SIG_CONTENT" | sed 's/`/\\\\`/g')\`,
        url: '$TAR_URL',
      },
    },
  };
  fs.writeFileSync('latest.json', JSON.stringify(manifest, null, 2) + '\n');
" 2>/dev/null || {
  # Fallback if the node heredoc tripped on shell quoting — use python instead.
  python3 - <<PYEOF
import json, datetime, pathlib
m = {
  "version": "$VERSION",
  "notes": """$NOTES""",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-aarch64": {
      "signature": pathlib.Path("$SIG").read_text(),
      "url": "$TAR_URL",
    },
  },
}
pathlib.Path("latest.json").write_text(json.dumps(m, indent=2) + "\n")
PYEOF
}

echo ""
echo "✓ Built v$VERSION"
echo "  $DMG"
echo "  $TAR"
echo "  $SIG"
echo "  $MANIFEST"
echo ""

# ---- 5. publish ----
GH_CMD=(gh release create "v$VERSION"
        --title "v$VERSION"
        --notes "$NOTES"
        "$DMG" "$TAR" "$SIG" latest.json)

if [[ "$PUBLISH" == "1" ]]; then
  echo "→ Publishing to GitHub"
  "${GH_CMD[@]}"
  echo ""
  echo "Released v$VERSION."
  echo "Anyone running an earlier version will see the update chip within 4s of their next launch."
else
  echo "To publish:"
  printf '  '
  printf '%q ' "${GH_CMD[@]}"
  echo ""
  echo "Or re-run with --publish."
fi
