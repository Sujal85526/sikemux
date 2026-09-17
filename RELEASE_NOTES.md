# Sikemux v0.4.0-nightly.6

The sixth nightly build. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

Almost all of this release is speed. Ninety-nine commits, and around sixty of them are about the app doing less work.

## The window stays responsive

- Commands that read disk or spawn a process no longer run on the main thread, and neither do pty commands, session listings or stash, remote and branch work. Attaching a terminal no longer stalls the app.
- Terminal output crosses IPC as raw bytes rather than a JSON array of numbers, the pty reader stops paying for every chunk, a hidden pane stops painting, and a slow renderer pushes back on the child instead of falling behind it. WebGL draws the terminal by default.
- The top bar, the backdrop, the side rail and the shell's palette stop repainting and rebuilding for nothing. The ambient field drifts at 30fps. A keystroke stops walking every binding and every store.

## Git, the editor and the chat

- One status walk per change instead of four; staging or discarding a range is one call; a file read at HEAD is cached; the log stops at the newest commits rather than walking the graph; the pane highlights its diffs in workers and mounts them lazily, and the merge review keeps its scroll position across refreshes.
- CodeMirror leaves the boot bundle and a language pack downloads when a file in it is opened. The gutter ships only changed lines, blame waits for a pause, the find bar stops re-searching on every render, and a save flushes the drive once.
- Typing a message redraws the composer rather than the transcript, streamed updates cross to the webview a frame at a time, and the transcript holds a handful of thumbnails instead of half a gigabyte.
- The browser's MCP sidecar is a single Rust process now, screenshots compress off the main thread, and agents read the protocol from a guide rather than every schema.

## When it does hang

- A hang leaves evidence behind, a frozen window can say what the UI was doing, and the overlay shows a stall while it is still forming.
- `sikemux doctor` reads the last autopsy.

## Fixes

- A second Sikemux stops answering for the first one's agents, and pty events reach the workbench rather than browser tabs.
- Expanding a file in the git pane draws instead of freezing, and the diff shows hunks rather than expandable context rows.
- A long URL, task name or queued message stops widening the chat pane, and a subagent stops looking alive once its turn is over.
- The project navigator stays a tree, rail toggles follow focus mode, and an agent can click an icon button.

For the complete patch history, compare [`v0.4.0-nightly.5...v0.4.0-nightly.6`](https://github.com/nodelike/sikemux/compare/v0.4.0-nightly.5...v0.4.0-nightly.6).
