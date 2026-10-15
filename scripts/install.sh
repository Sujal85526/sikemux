#!/bin/sh
# Installs Sikemux: curl -fsSL https://sikemux.com/install | sh
# Set SIKEMUX_CHANNEL=nightly for the nightly build.
set -eu

REPO="https://github.com/nodelike/sikemux"
CHANNEL="${SIKEMUX_CHANNEL:-stable}"

say() { printf '%s\n' "$*"; }
fail() { printf 'sikemux install: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"

latest_version() {
  case "$CHANNEL" in
    stable)
      url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$REPO/releases/latest") || fail "could not reach GitHub"
      printf '%s' "${url##*/tag/v}"
      ;;
    nightly)
      curl -fsSL "$REPO/releases/download/nightly/latest.json" |
        sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -n 1
      ;;
    *) fail "SIKEMUX_CHANNEL must be stable or nightly, not $CHANNEL" ;;
  esac
}

VERSION=$(latest_version)
[ -n "$VERSION" ] || fail "could not find the latest $CHANNEL version"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

download() {
  say "Downloading $1"
  curl -fL --progress-bar -o "$TMP/$1" "$REPO/releases/download/v$VERSION/$1" ||
    fail "v$VERSION has no $1${2:+. $2}"
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else fail "run this as root, or install sudo"
  fi
}

install_mac() {
  [ "$(uname -m)" = arm64 ] || fail "Sikemux needs a Mac with Apple Silicon"
  if pgrep -xq Sikemux; then fail "quit Sikemux first, then run this again"; fi
  download Sikemux.app.tar.gz
  tar -xzf "$TMP/Sikemux.app.tar.gz" -C "$TMP"
  dest=/Applications
  [ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
  rm -rf "$dest/Sikemux.app"
  mv "$TMP/Sikemux.app" "$dest/Sikemux.app"
  say "Installed Sikemux $VERSION in $dest"
  open "$dest/Sikemux.app"
}

install_linux() {
  [ "$(uname -m)" = x86_64 ] || fail "Sikemux for Linux needs an x86_64 machine"
  hint="Linux builds ship in nightlies first; try SIKEMUX_CHANNEL=nightly"
  if command -v apt-get >/dev/null 2>&1; then
    download "Sikemux_${VERSION}_amd64.deb" "$hint"
    as_root apt-get install -y "$TMP/Sikemux_${VERSION}_amd64.deb"
  elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then
    download "Sikemux-${VERSION}-1.x86_64.rpm" "$hint"
    if command -v dnf >/dev/null 2>&1; then
      as_root dnf install -y "$TMP/Sikemux-${VERSION}-1.x86_64.rpm"
    else
      as_root zypper --non-interactive install --allow-unsigned-rpm "$TMP/Sikemux-${VERSION}-1.x86_64.rpm"
    fi
  else
    download "Sikemux_${VERSION}_amd64.AppImage" "$hint"
    mkdir -p "$HOME/Applications"
    mv "$TMP/Sikemux_${VERSION}_amd64.AppImage" "$HOME/Applications/Sikemux.AppImage"
    chmod +x "$HOME/Applications/Sikemux.AppImage"
    say "Installed the AppImage as ~/Applications/Sikemux.AppImage"
  fi
  say "Installed Sikemux $VERSION"
}

case "$(uname -s)" in
  Darwin) install_mac ;;
  Linux) install_linux ;;
  *) fail "Sikemux runs on macOS and Linux" ;;
esac
