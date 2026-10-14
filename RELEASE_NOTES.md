# Sikemux v0.5.3-nightly.2

The second nightly on the 0.5.3 line. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## New since nightly.1

- **Agents work together.** Every agent gets a name, like Otter, shown in its tab, rows and header. Agents list each other and send messages with `agent_send`, start helpers with `agent_spawn` in a chat or a terminal, read what another agent said with `agent_read` and wait on it with `agent_wait`. A worker opens beside its lead in the same project and worktree, sits under it in the rail on its tree line, and its lead hears when its turn ends or fails. Closing a lead asks whether its agents stop with it. @ mentions name the project's other agents and its earlier chats.
- **Questions.** Agents ask their lead or you with `ask`, and Claude's own questions go the same way. A question waiting on you shows under its agent in Needs input, in its notification and in the notch island, and you answer it in the chat, from the island or on your phone. Needs input also lists what an agent went on assuming.
- **Boards.** Each project has a board of cards that agents add, claim and finish, from a Board row beside Files, Git and Search. Send a Jira issue to the board with its subtasks, and a card's ticket moves with it in Jira. Turn on Auto and Sikemux starts an agent on each card you add, in its own worktree, and lands its work once the agent and its workers are done.
- **The rail.** Agent rows name their project, worktree and pull request, hung off the row as a tree. A line under the scope switch shows what is running, and New chat, New terminal and New browser rows sit at the top.
- **Security.** rustls 0.23.46 fixes four advisories (RUSTSEC-2026-0346 to 0349), and every agent's tool calls carry a secret that proves they are its own.
- Bitbucket agents can read one pull request with its builds, edit one, and merge the repository's way.
- Jira shows people's pictures on the board, and a browser sign-in renews its token once when Jira refuses it.
- A finished background subagent shows its own card, a workflow's row counts its finished agents, and connecting to a session no longer looks like a running turn.
- Share sits on the chat's name, and a shared chat shows a green eye with its viewer count.
- A Markdown preview follows the file when an agent edits it on disk.

For the complete patch history, compare [`v0.5.3-nightly.1...v0.5.3-nightly.2`](https://github.com/nodelike/sikemux/compare/v0.5.3-nightly.1...v0.5.3-nightly.2).
