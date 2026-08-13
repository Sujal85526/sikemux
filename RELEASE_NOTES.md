# Sikemux v0.2.0

Sikemux 0.2.0 is the biggest release yet. Project sessions now behave like durable developer workspaces: they can run trusted project automation, keep native tasks alive across view changes, surface editor diagnostics, launch local coding agents, and hand files to the app from the command line. This release also brings Windows support, a redesigned first-run experience, and broad reliability, security, and performance work throughout the desktop runtime.

## Highlights

### Project actions, tasks, and previews

- Add checked-in `sikemux.json` support for project-scoped actions, keyboard shortcuts, tasks, and preview configuration.
- Review executable project configuration before trusting it, keep approval process-scoped, and ask again whenever the file changes.
- Run tasks in runtime-owned native PTYs so terminal views can detach and reattach without killing the underlying process.
- Keep task stop and restart controls generation-safe, including when configuration changes while a task is running.

### Local coding-agent workflows

- Redesign agent launch and resume flows for Claude, Codex, Hermes, Pi, and OpenCode.
- Show live permission modes, safety controls, activity state, and usage limits directly in the agent rail.
- Stream commit-message suggestions from locally installed Codex, Claude, or Hermes clients without sending diffs to a Sikemux-hosted model service.
- Improve agent session reconciliation, launch notifications, and terminal ownership across project reloads.

### Editor and workbench

- Add project-scoped Problems and Outline views backed by LSP diagnostics and document symbols.
- Add bounded back and forward navigation across editor locations.
- Move workbench items onto durable runtime controllers with versioned, transactional persisted state.
- Maintain worktree snapshots incrementally and tighten filesystem watcher ownership to avoid drift and duplicate work.

### CLI, Git, and onboarding

- Bundle the native `sikemux` and `sikemux-editor` launchers for opening projects or exact file locations, including `--wait` support for editor workflows such as Git commits.
- Add an embedded Git terminal, worktree support, safer discard confirmation, and streamed AI-assisted commit messages.
- Add an interactive first-run tour and make default keyboard shortcuts fully reassignable or removable.

### Windows and platform support

- Add Windows desktop builds with native ConPTY terminals, PowerShell defaults, platform-aware shortcuts, and an NSIS packaging target.
- Normalize cross-platform paths and shell behavior while preserving the existing Apple Silicon macOS release and updater flow.
- Gate WebGL terminal rendering behind an opt-in path with automatic fallback to the DOM renderer.

### Reliability, performance, and security

- Bound native PTY, LSP, filesystem, persistence, and task resources to prevent runaway processes, renderer restart storms, and stale controllers.
- Add redacted browser and native diagnostics, latency tracing, performance budgets, and a native hang watchdog.
- Harden the desktop CLI broker, project action trust boundaries, credential handling, and private-network Rundeck HTTP access.
- Fix terminal scrollbars, path quoting, startup hydration, stale editor symbols, Git discard behavior, task lifecycle edge cases, and agent safety controls.

## Upgrade notes

- Existing persisted workspace state is handled through the new versioned migration path.
- Executable project actions and tasks require review before they run; approval is intentionally not persisted across app processes.
- Windows build support is included, but the published automatic-update feed continues to target Apple Silicon macOS.

For the complete commit history, compare [`v0.1.31...v0.2.0`](https://github.com/nodelike/sikemux/compare/v0.1.31...v0.2.0).
