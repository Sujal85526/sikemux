# Sikemux Mobile Android

Native Android companion for Sikemux, built with Kotlin + Jetpack Compose.

## What works in this MVP

- Connect to desktop Sikemux mobile sync over Tailscale/local network.
- Pair by scanning the QR code in desktop Settings → mobile, or paste the token manually.
- Show project list from the desktop workspace snapshot.
- Show live PTYs for the selected project.
- Spawn a mobile-native terminal in a project.
- Attach to a PTY, receive snapshot/output, and type back into it.
- Start mobile-native agents by spawning PTYs with `pi`, `claude`, `codex`, `hermes`, or `opencode` as startup commands.
- In-app dynamic-island style status pill/card.
- Actual Android foreground-service notification for OS live activity / HyperOS island-style surfaces while connected.

## Desktop dev server

From the repo root:

```bash
SIKEMUX_MOBILE_SYNC=1 SIKEMUX_MOBILE_BIND=0.0.0.0:48731 pnpm tauri dev
```

Then open desktop Sikemux → Settings → mobile → set the QR URL to your Mac Tailscale URL:

```txt
http://100.x.y.z:48731
```

On Android, tap **Scan QR**. Manual fallback:

```txt
Host: 100.x.y.z:48731
Token: cat ~/.config/sikemux/mobile.token
```

## Build

Open `mobile/android` in Android Studio, or run from this directory if you have Gradle/Android SDK configured:

```bash
gradle :app:assembleDebug
```

The terminal viewport is Compose shell + WebView/xterm.js. xterm is loaded from jsDelivr for the first MVP; vendoring the asset is the next polish step so the terminal works fully offline.

## OS live notification

The app starts a foreground-service notification while connecting/connected. On Xiaomi/HyperOS, allow notification permission and enable floating notifications for Sikemux if you want the OS island-style surface to appear. Android does not expose a public Dynamic Island API, so this uses the proper OS notification/live-service path rather than an overlay hack.

## Next polish

- Move the WebSocket into the foreground service so the connection survives activity death.
- QR pairing instead of manual token paste.
- Device records/revocation and biometric unlock before write mode.
- Vendor xterm.js assets locally.
- Agent resume/session discovery actions.
- Reconnect replay buffer for PTY output.
