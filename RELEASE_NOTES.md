# Sikemux v0.5.3-nightly.2

The second nightly on the 0.5.3 line. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## New since nightly.1

- **Agents work together.** Every agent gets a name, like Otter, shown in its tab, rows and header. Agents list each other and send messages with `agent_send`, start helpers with `agent_spawn` in a chat or a terminal, read what another agent said with `agent_read` and wait on it with `agent_wait`. A worker opens beside its lead in the same project and worktree, sits under it in the rail, and its lead hears when its turn ends or fails. Each project keeps a log of the messages between its agents, in a Messages panel beside its board, and two agents bouncing messages with nothing else to do are held after four rounds.
- **Workers on your other computers.** Link the computers on your account in Settings, and an agent can start workers on another host. They show under their lead in the rail, named with their host, as in Otter on studio.
- **One inbox.** The rail, the notch island and your phone draw the core's ranked inbox: what needs you first, then what to review, finished work and what's running. Permissions and questions are answered right on the row, and coming back after a while shows what finished and failed while you were away.
- **Questions.** Agents ask their lead or you with `ask`, and Claude's, Codex's and Muse's own questions go the same way. A secret question, like a password, is answered in a masked field and reaches the agent as a private file, never as text in a transcript.
- **Agents stay out of each other's way.** Every agent's git refuses commands that sweep up other agents' work in a shared checkout, such as `add -A`, `commit -a`, `stash` and `reset --hard`, and allows them in its own worktree. Agents commit only their own lines with `git_commit`, the Git pane shows which agent wrote each change and commit, and agents sharing a checkout hear when they edit the same file.
- **Boards and Auto.** Each project has a board of cards that agents add, claim and finish. Send a Jira issue to it with its subtasks, and a card's ticket moves with it in Jira. Auto starts an agent on each card in its own worktree, answers review comments on GitHub and Bitbucket, and merges only after an agent on another CLI has reviewed the diff against the card's acceptance criteria.
- **Model providers.** Claude Code and Codex chats can run on a connected provider, coding plans and local models included. The model picker says who pays, helpers run on a model of their own, and model facts come from models.dev.
- **Usage limits.** A Claude or Codex chat stopped by a usage limit sends its prompt again once the limit resets.
- **Find old sessions.** Agents find a past session from a vague memory and resume it, and the composer's earlier chats come from the same search.
- **Network.** When the network comes back or the computer wakes, panes that failed load again, and the phone, account and share links reconnect at once. A chat whose agent is retrying reads Reconnecting… or Retrying….
- **Plugins.** They live in the background core, so agents keep their plugin tools while the window is closed. AWS agents read ECS, logs, metrics, load balancers and EC2, the AWS pane installs the CLI and sets up a profile in one click, and Rundeck agents run and follow jobs. The Jira pane reads like Jira's own, with spaces, swimlanes, epics, due dates and pictures. Plugin and SSH rows in the rail show whether they're signed in or connected.
- **Security.** rustls 0.23.46 fixes four advisories (RUSTSEC-2026-0346 to 0349). Tool calls are tied to the agent whose processes make them, only Sikemux's own window and notch can act as you, and only Sikemux's own app can replace the core.
- The background core keeps your projects and agents and starts and wakes chats on its own, and on Linux a systemd user service starts it at login. A host with no browser signs in by a code you approve at app.sikemux.com.
- A finished background subagent shows its own card, a running command opens to show all of it, and Share sits on the chat's name.
- A Markdown preview follows the file when an agent edits it on disk.

For the complete patch history, compare [`v0.5.3-nightly.1...v0.5.3-nightly.2`](https://github.com/nodelike/sikemux/compare/v0.5.3-nightly.1...v0.5.3-nightly.2).
