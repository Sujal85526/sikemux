# Sikemux v0.4.3-nightly.2

The second nightly on the 0.4.3 line. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## New since nightly.1

- **The agent's browser keeps out of your way.** Its keys act in the tab and never reach what you are typing, its clicks leave your cursor alone, and your keyboard comes back when it is done.
- **The agent's browser does more.** It can open a local file or folder, wait on a condition, reload, and say what an action really did. A tab notices when its page hangs or crashes, and a fixed viewport lays the page out at its real size.
- **Agents run and read more.** `task_start` runs a one-off command in a managed terminal and answers within 30 seconds. Agents can read the app's own console, and a misnamed tool argument points at the one the agent meant.
- **YOLO means YOLO.** A YOLO chat answers every permission ask, Claude and Codex included, and a YOLO agent starts `sikemux.json` tasks without the trust dialog.
- Opening the app's window from a tool bounces the Dock instead of taking another app's keyboard.
- A pane divider stops glowing once the drag ends, and an older GitHub run attempt keeps the way back to the latest one.

For the complete patch history, compare [`v0.4.3-nightly.1...v0.4.3-nightly.2`](https://github.com/nodelike/sikemux/compare/v0.4.3-nightly.1...v0.4.3-nightly.2).
