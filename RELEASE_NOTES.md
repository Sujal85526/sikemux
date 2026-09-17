# Sikemux v0.4.0-nightly.3

The third nightly build. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## The browser

- A tab is a native child webview rather than a stream of Chromium screenshots, so a page scrolls, types and renders at the speed the page actually runs.
- The agent drives the same tabs you see, instead of a second browser of its own.
- A page's `alert`, `confirm` and `prompt` appear in the pane, and one of them no longer wedges the browser. A closed tab's clicks stop waiting for an answer that will never come, and a dead connection is noticed instead of hanging.
- Downloads land in the Downloads folder.
- The build no longer ships a Chromium runtime, which is most of the download gone.

## The session view

- A turn's tool calls hang off a tree, and an edit shows the hunk it wrote, read out of the tool call itself.
- A patch inside a fence reads like the one an edit shows, tables the agent writes are ruled and bordered and stay legible over a wallpaper, and an MCP call gets a plug rather than a sparkle.
- A message written mid-turn waits for its own turn rather than being refused.
- The running row names the work, a finished run of tools folds away, and only a failed run is marked in the summary.
- The harness menu opens straight onto the harnesses, each appearing once and wearing its own colour, and the model picker names the release rather than just the family.

## Elsewhere

- The dither paints its dots and nothing between them.
- A swipe whose screens move under it hands the track back, and revealing the last tab no longer shoves the stage sideways.
- The GUI/TUI pair reads as one toggle again, and every control in the agent header is one height.
- The composer fades with the window, and a menu never does.

For the complete patch history, compare [`v0.4.0-nightly.2...v0.4.0-nightly.3`](https://github.com/nodelike/sikemux/compare/v0.4.0-nightly.2...v0.4.0-nightly.3).
