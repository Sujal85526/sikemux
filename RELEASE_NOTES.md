# Sikemux v0.5.1-nightly.2

The second nightly on the 0.5.1 line. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## New since nightly.1

- **The iOS Simulator on the desk.** An agent's desk can hold a live iOS Simulator you use directly, with its bezel, side buttons and rotation. Agents drive it too, through `sim_` tools: tap, type, swipe, read the log and take screenshots. Sikemux downloads the simulator helper the first time you need it, and Settings has a section for it.
- **Claude and Codex, driven directly.** Sikemux now speaks each agent's own protocol instead of going through ACP adapters. Edit a sent message and ask again, and a loaded Claude chat shows what its subagents did.
- **Chats load faster and whole,** resume already at the bottom, hold their place while you scroll, and tool rows draw an icon for what each call does.
- **Agents say whether they are ready.** Every agent reports whether it is missing, broken, signed out or ready, the welcome screen and agent palette tell you before you start, and a chat refused for sign-in marks its agent at once.
- **Files.** The file tree docks beside the stage and files open as tabs, with Material file icons. Gitignored files are dimmed.
- **The rail.** Agents show under the open project's row, and the Term row is gone.
- **Phones on your account** are let in when you sign in, after Sikemux asks you once.
- Right-clicking a desk tab copies its path or link.

Thanks to Ankit Patidar for the simulator tab and its helper, agent sign-in status, dimmed gitignored files and desk tab menus, and to Sujal Rajput for the agents' simulator tools and its Settings section.

For the complete patch history, compare [`v0.5.1-nightly.1...v0.5.1-nightly.2`](https://github.com/nodelike/sikemux/compare/v0.5.1-nightly.1...v0.5.1-nightly.2).
