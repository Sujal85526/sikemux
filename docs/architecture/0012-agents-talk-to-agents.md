# ADR 0012: Agents talk to agents through the core

- Status: Accepted
- Decision date: 2026-10-14

## Context

People run several agents on one project, often from different CLIs, and want one to hand
work to another: Claude plans while Codex builds, a lead splits a ticket among workers, and
everyone answers questions without the person relaying text between panes. Claude Code
ships its own `ListAgents` and `SendMessage`, but only between Claude sessions, and a
session that skips permission prompts holds every incoming message for approval; a chat
the core runs headless cannot show that prompt and drops the message after five minutes.
Claude's channels, which push text into a session, ignore headless sessions. Neither
reaches Codex or the ACP agents.

The core already drives every chat agent itself (ADR 0006): it starts them, sends prompts,
steers a running turn without stopping it (Claude takes a message at its next tool call,
Codex through `turn/steer`), and records every event. It also serves the `sikemux-tools`
MCP server every agent is launched with.

## Decision

- **Agent-to-agent is core tools, not a protocol.** `agent_list`, `agent_spawn`,
  `agent_send`, `agent_read` and `agent_wait` are `sikemux-tools` methods answered in the
  core's harness, so they work for every CLI and with the window closed. The A2A protocol
  is left for a later adapter at the edge, for agents outside Sikemux.
- **Every agent has a name.** The core gives each agent a short noun from a built-in list
  (Otter, Maple, Flint) when it starts, unique among the project's agents and not reused
  while a past agent of that name is still in the recent list. Leads do not choose names.
  The person can rename one. Tools, `@` mentions in the composer, tabs and the rail all
  use the name.
- **A tool call proves who is calling.** Each agent is launched with its own secret, and
  the core checks it on every harness call. An agent id the caller merely states is not
  trusted.
- **Messages are text, labelled as coming from an agent.** A message can never answer a
  permission prompt or change configuration. Any agent may message any other, across
  projects.
- **Delivery steers first.** A busy agent that can steer reads the message at its next
  tool call; an idle one gets it as a new turn. Only an agent that can do neither, such as
  a terminal agent mid-turn, has it queued in the core, up to ten, and delivered when its
  turn ends.
- **A spawned agent is a full agent.** It opens in its own tab, takes its lead's account
  and permission mode (the lead may pick the CLI and model, never the mode), and is
  recorded with the agent that spawned it. When its turn ends, its final answer goes to its
  lead. Spawning is capped at two levels deep, six children per agent and eight spawned
  agents per project.
- **Questions go to the lead first.** An `ask` tool, which Claude's own `AskUserQuestion`
  routes into, sends a worker's question to its lead; the lead answers or passes it to the
  person. A worker that is not blocked goes ahead on a stated assumption, and a card with an
  open question or an unseen assumption does not merge.
- **Work is tracked on one board per project.** Cards have a parent and dependencies and no
  types. Claiming is a single step in the core. Only the person moves a Jira or Linear
  ticket onto the board, and the board's automatic pickup starts agents only for cards the
  person added.

## Consequences

- Every launch path that hands an agent `sikemux-tools` also hands it its secret: terminal
  agents, chats the app starts and chats a device starts.
- The core keeps per-agent names, parent links and queued messages, and they survive a
  window reload and a core upgrade.
- The rail lists workers flat, right after their lead, joined by the lead's tree line.
- Phones reach the same tools as `Call` methods (ADR 0010), never new wire requests.
- A lead that is compacted or closed does not lose the plan: it lives on the board.

## Alternatives considered

- **Claude's own cross-session messaging.** Rejected: Claude only, and it drops messages
  to the headless, prompt-skipping sessions Sikemux runs.
- **Claude channels for delivery.** Rejected: research preview, needs a development flag
  with a warning screen, and is ignored in headless sessions.
- **The A2A protocol inside Sikemux.** Rejected for now: a network endpoint and identity
  model for agents that are all local processes the core already drives.
- **Holding messages from other projects for approval.** Rejected: every agent is the
  person's own and can already reach the other project's files.
- **Nesting workers under their lead in the rail.** Rejected: rows already hang their own
  project, branch and pull request tree, and a tree inside a tree truncates titles.
