# Sikemux v0.4.3-nightly.5

The fifth nightly on the 0.4.3 line. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## New since nightly.4

- **Your agents keep working when the window closes.** Terminals and chat agents now run in a background core, so quitting Sikemux leaves them running and reopening it puts every pane back where it was. A chat agent comes back mid-turn, with its permission request still waiting. Quit and Stop Everything ends them all.
- **Updates no longer stop anything.** A newer Sikemux takes over the running core in place, panes keep their screens, and an update waits for chat agents to finish their turns.
- **Crashed agents come back.** A terminal agent that dies returns on its conversation in the same pane, and agents' tools keep answering with the window closed.
- **Worktrees.** Start a chat in its own git worktree. Sikemux shows the worktree's pull request and cleans it up once it is merged.
- **Ports.** A chip in the top bar counts the ports your project's terminals, tasks and agents listen on, and agents can list them too.
- **Spaces.** Group projects into spaces of your own, each with a name and an optional emoji, and switch between them from the Projects header. A space shows only its projects and All shows every one; hiding a project this way never closes it. Right-click a project to move it to another space.
- **Model providers.** Paste a hosted model provider's key once in Settings, and OpenCode, Pi and OMP pick it up.
- **Remote access, first steps.** A new Devices page in Settings turns on remote access and pairs a device with a code you approve, shown with a QR code, and the Mac can be found on the same network. A paired device can start a chat agent in one of your projects; its chats show among the project's agents on the Mac, and a prompt shows for everyone watching the chat. While remote access is on, the core starts at login. There is no phone app to install yet; this is the groundwork for one.
- **Faster start.** Sikemux reads your login shell while the window opens and no longer runs zoxide at launch.
- **The chat.** Pick a new chat's project from a strip above the composer, or move a chat that has not started to another project. Attached files show as cards with their file type, and a long tool run redraws only the row that changed. The Git pane shows each pull request's CI in its list.
- **Fixes.** Agents get your shell's UTF-8 locale, so tools such as Ruby no longer fall back to ASCII, and a browser tab an agent opens just after launch stays open.

For the complete patch history, compare [`v0.4.3-nightly.4...v0.4.3-nightly.5`](https://github.com/nodelike/sikemux/compare/v0.4.3-nightly.4...v0.4.3-nightly.5).
