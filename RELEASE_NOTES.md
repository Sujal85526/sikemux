# Sikemux v0.4.0-nightly.1

The first nightly build. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## Agents

- Agent panes run over a managed ACP session transport, with live session configuration, model and effort pickers, and a structured session view.
- Session titles update while a run is still going, and agent panes launch through your configured interactive shell.
- Harness commands are authenticated and retain task output, exposing project tasks, workspace views and event waits to agents.

## Workspace

- Editor, diff and search open as tabs in one per-session tab strip, and ⌘T opens a numbered new-tab chooser.
- Git left its own tab for the workspace rail, which now holds agents, files and changes together.
- Large file trees, tab strips and diff reviews are virtualized, and reviews render in workers.

## Appearance

- A token-based design system covers palettes, menus, dialogs and overlays, with one backdrop for the whole window and one radius per role.
- Interface text scales to 110% or 125% while the workspace stays compact.

## Performance

- Editor views, Git workbench data and terminal renderers survive tab switches instead of being rebuilt.
- Project and Git refreshes fan out more narrowly, and resource refreshes are coalesced so activity no longer delays saves.

For the complete patch history, compare [`v0.3.4...v0.4.0-nightly.1`](https://github.com/nodelike/sikemux/compare/v0.3.4...v0.4.0-nightly.1).
