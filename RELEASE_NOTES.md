# Sikemux v0.5.0-nightly.9

Chats, terminals and SSH hosts work on Macs whose shell starts slowly. Nightlies are signed and delivered exactly like stable releases, but they carry unreleased work and can break. Switch back to stable in Settings → About whenever you want; you keep the build you are on until a stable release passes it.

Everything below is new since v0.5.0-nightly.8.

## Agents that work out of the box

- **Chats no longer say "Authentication required" while Claude works in your terminal.** When your shell took more than a few seconds to start, Sikemux ran its agents without the system folders on their PATH, so Claude could not read its sign-in from the Keychain. Every agent, terminal and task now gets a PATH with them, even from a background core started by an older build.
- **SSH hosts connect again** on those Macs, where `ssh` and `sleep` were reported as not found.
- **A slow shell profile costs only the first few seconds.** If your shell answers after Sikemux stops waiting, its PATH and variables are picked up as soon as it does, instead of being missed until you quit everything. Anything that goes wrong reading it is written to the core's log.
- **Chats get what your shell exports.** Variables a provider profile forwards, such as an API key in `.zshrc`, and a `CLAUDE_CONFIG_DIR` or `CODEX_HOME` set there, now reach chats when Sikemux is opened from the Dock.
- **Node from nvm, Volta, mise, asdf and fnm is found** even when your shell cannot be read, and Claude chats run on a Node new enough for them (22 or newer), saying plainly when there is none. A failed adapter install shows npm's actual error.
- **Git and other tools Sikemux runs use your shell's SSH agent and locale**, so pushing through 1Password or Secretive works as in a terminal.
- **A brand-new chat whose first message failed** now carries on in a fresh session once you are signed in, instead of "Resource not found".

## Notch and plugins

- **An open island on a screen without a notch is narrower** and clears the screen edge.
- **Built-in plugins show their logo** in Settings, and a plugin tool's row in a chat shows the plugin's mark. Links to Jira, Bitbucket and GitHub lead with the service's mark.

For the complete patch history, compare [`v0.5.0-nightly.8...v0.5.0-nightly.9`](https://github.com/nodelike/sikemux/compare/v0.5.0-nightly.8...v0.5.0-nightly.9).
