# Sikemux v0.4.0-nightly.4

The fourth nightly build. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

## Agents can see the browser again

- For nine days no agent could find a browser tool. Moving agent panes onto the interactive shell took the per-host wiring with it: the environment variables kept being exported and nothing read them, so a model asked to use the browser went looking for a command named after it.
- Each host is told its own way again, from one place — a config file on the command line for Claude, dotted overrides for Codex, the bundled extension for Pi and omp, a private home for Hermes and Grok, and config content for OpenCode. None of it disturbs the MCP servers you configured yourself.
- An agent pane runs on one of two transports, and both are told now. The chat pane speaks ACP, where the agent sits behind an adapter and never sees a command line, so its sessions declare the browser as an MCP server of their own on both the new-session and resume paths. A session that cannot be told still runs, without the tools.

## The session view

- A run of tool calls stays open until the agent moves on, rather than folding away while it is still working.
- An attachment sits under the message that sent it.

For the complete patch history, compare [`v0.4.0-nightly.3...v0.4.0-nightly.4`](https://github.com/nodelike/sikemux/compare/v0.4.0-nightly.3...v0.4.0-nightly.4).
