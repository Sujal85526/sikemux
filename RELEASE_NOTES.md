# Sikemux v0.2.3

Sikemux 0.2.3 restores the direct, terminal-first agent workflow. Agent CLIs open in a PTY without an intermediate task composer or worktree setup, while the classic searchable session picker and the original live YOLO toggle are back.

## Agent workflow

- Open the classic agent picker with `⌥N`, start a fresh local CLI, or resume a recent project-scoped session.
- Launch agents directly in the current project without task-input, model, worktree, or notification UI.
- Keep launch safety focused on the two supported modes: Normal and YOLO.
- Restore the one-click `safe` / `yolo` control over live agent terminals, including `⌥Y`, immediate PTY restart, provider-specific bypass flags, and the original armed-state treatment.
- Exclude global Hermes history from project session results while keeping fresh Hermes launches available.
- Accept native image-file drops in supported agent terminal flows.

## Development

- Give `make dev` its own `Sikemux Dev` identity and application-data directory so the debug binary can run beside an installed release without tripping the single-instance guard.

## Upgrade note

Existing resumable agent sessions remain available. Changing Normal or YOLO mode restarts the underlying CLI because those permissions are process launch flags; resumable sessions reopen with their session ID.

The published automatic-update feed continues to target Apple Silicon macOS.

For the complete patch history, compare [`v0.2.2...v0.2.3`](https://github.com/nodelike/sikemux/compare/v0.2.2...v0.2.3).
