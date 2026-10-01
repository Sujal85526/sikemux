# Sikemux v0.4.3-nightly.4

The fourth nightly on the 0.4.3 line. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## New since nightly.3

- **Send anything to an agent.** Pick which agent gets it, then hand over a terminal selection, a problem from the editor, SigNoz log lines or a pull request's diff lines. Start a new chat agent on an issue straight from the Git pane.
- **The composer.** `@` attaches a project file or folder, and `#` hands over an issue or pull request.
- **The chat.** Find text in a conversation with ⌘F, and Escape stops the running turn. Each prompt shows when it was sent, and its answer shows when it finished and how long it took. A chat whose agent died can be resumed, a session says why it ended, and a resumed session past 200K tokens gets the 1M window.
- **Switch accounts** for Claude or Codex from the limits footer in the rail.
- **Under 10 MB again.** The download drops from 11.5 MB to about 10 MB. The voice helper is no longer bundled: Sikemux downloads it the first time you dictate, checked against the exact build it expects, the same way it fetches the speech model.
- The up and down arrows bring back sent messages only from an empty composer, and agents can be closed from the all projects list.

Thanks to Ankit Patidar for find in conversation, Escape to stop, and the timing on each turn.

For the complete patch history, compare [`v0.4.3-nightly.3...v0.4.3-nightly.4`](https://github.com/nodelike/sikemux/compare/v0.4.3-nightly.3...v0.4.3-nightly.4).
