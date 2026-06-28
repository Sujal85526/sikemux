# Sikemux Mobile Companion

Android companion MVP for projects, agents, and terminals. The mobile app connects to the desktop Sikemux process over Tailscale/local network and treats desktop Sikemux as the first server. Later the same protocol can move behind a headless `sikemuxd` daemon.

## MVP principles

- Mobile gets a smooth native UI, not a pixel-for-pixel copy of desktop.
- Sync work state, not layout: projects, agents, terminals, status, output, and input are shared; mobile layout/font/island state are local.
- Phone-created terminals/agents should be mobile-native by default. Existing desktop terminals are attachable without automatic resize.
- Typing from mobile is allowed, but all write APIs require pairing auth.

## Desktop sync server

The first slice lives in `src-tauri/src/mobile_sync.rs`.

Routes:

- `GET /health` — unauthenticated health check.
- `GET /state` — authenticated persisted/live workspace snapshot.
- `GET /ws` — authenticated WebSocket for live state events and heartbeat.

Tauri commands:

- `mobile_sync_start({ bind?: string })`
- `mobile_sync_stop()`
- `mobile_sync_status()`
- `mobile_sync_pairing_info()`
- `mobile_sync_update_state({ data })`

By default the server binds to `127.0.0.1:48731`. For a Tailscale test run, start Sikemux with:

```bash
SIKEMUX_MOBILE_SYNC=1 SIKEMUX_MOBILE_BIND=0.0.0.0:48731 pnpm tauri dev
```

Pairing token is stored at:

```txt
~/.config/sikemux/mobile.token
```

Auth can be supplied as either:

```http
Authorization: Bearer <token>
```

or, for quick manual testing only:

```txt
/state?token=<token>
/ws?token=<token>
```

## WebSocket protocol v1

Server events:

```json
{ "type": "hello", "app": "sikemux", "service": "mobile-sync", "protocol": 1 }
{ "type": "state.snapshot", "state": { } }
{ "type": "state.changed", "state": { } }
{ "type": "heartbeat" }
```

Client messages currently supported:

```json
{ "type": "ping" }
{ "type": "pty.list" }
{ "type": "pty.spawn", "cwd": "/repo", "cols": 80, "rows": 24, "startup": null }
{ "type": "pty.attach", "ptyId": 12 }
{ "type": "pty.resize", "ptyId": 12, "cols": 80, "rows": 24 }
{ "type": "pty.write", "ptyId": 12, "data": "ls\n", "clientMsgId": "..." }
{ "type": "pty.detach" }
```

Server replies/events:

```json
{ "type": "pong" }
{ "type": "pty.list", "ptys": [{ "id": 12, "rows": 40, "cols": 140, "cwd": "/repo", "startup": null, "subscribers": 2 }] }
{ "type": "pty.spawned", "ptyId": 12 }
{ "type": "pty.snapshot", "ptyId": 12, "subId": 99, "data": "base64-ansi-snapshot" }
{ "type": "pty.output", "ptyId": 12, "data": "base64-ansi-chunk", "eof": false }
{ "type": "ack", "ok": true, "clientMsgId": "..." }
```

PTY `data` fields are base64 encoded bytes because ANSI output is not guaranteed to be valid UTF-8.

## Next protocol slices

Agent control:

```json
{ "type": "agent.start", "projectId": "sess_...", "agent": "pi" }
{ "type": "agent.resume", "projectId": "sess_...", "agent": "claude", "resumeId": "..." }
{ "type": "agent.prompt", "agentId": "agent_...", "text": "..." }
```

Security hardening beyond the MVP token:

- add device records + revocation
- add per-device permissions: view, write, start agents, kill, YOLO
- require biometric unlock on Android before write mode
- add replay/missed-output buffers for reconnects before depending on long-running mobile sessions
