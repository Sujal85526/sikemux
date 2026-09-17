# Sikemux v0.4.0-nightly.2

The second nightly build. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## The stage

- A session's screens sit side by side on one track, and a two-finger trackpad swipe moves between them. The swipe is a scroller rather than a negotiation: it follows the hand, lands from a short pull or a light flick, ends when the hand leaves, and gives further at either end of a session.
- Each screen is a card that carries its own frame and corners, so a swipe slides a screen rather than sliding content behind a frame that stays put. A gap travels between them, and a readout shows how far along its screens a session is.
- The tab strip is a bar of its own above the screens, and two documents of one screen slide in place.

## Windows and tabs

- Panes stack into a tab strip inside a window, which is now a third kind of split alongside rows and columns.
- A tab is a window, and maybe a document. Every strip — workspace, browser and Bruno requests — cycles through one ordered list and shares the same tab bar.
- The plus asks what kind of tab to open rather than which agent, and the active pill stays where it can be seen.

## Agents

- A message typed while an agent is working now joins the running turn instead of waiting for it, on agents that take steering.
- Background tasks and subagents reach the session view: a live task sits above the composer with its progress and a stop button, a subagent keeps a thread of its own, and a finished task says how it went.
- A running turn says so, and says for how long. An attached image shows itself rather than its file name, and a slash part-way through a draft still names a command.
- Switching to a sleeping agent wakes it, and the TUI view carries its own YOLO switch again.

## Browser

- The browser pane starts before an agent asks for it and says when a tab opens, so the first request no longer waits on a cold start.
- Its Chromium stops announcing itself as headless, keeps the keys it is given, and no longer bundles its framework binary twice.

## Appearance

- The dither belongs to the screen being read rather than the gutter it used to show through.
- Themes anchor their ramp on the theme's own panel rather than its recess, which had left Aura a step darker than Aura.
- Settings carries its own frame, one row grammar and a real theme swatch, and the rail update chip shows download progress.

For the complete patch history, compare [`v0.4.0-nightly.1...v0.4.0-nightly.2`](https://github.com/nodelike/sikemux/compare/v0.4.0-nightly.1...v0.4.0-nightly.2).
