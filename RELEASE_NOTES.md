# Sikemux v0.3.2

Sikemux 0.3.2 gives the terminal back your real shell, and rebuilds the settings panel around one list of project folders.

## Terminal

- Load your shell configuration, and keep your history. Shell integration hooked zsh by pointing `ZDOTDIR` at a scratch directory and forwarding your startup files back to the real one. The forwarding worked, but `ZDOTDIR` is not only a lookup path: anything your configuration derives from it followed the scratch directory — `HISTFILE` above all — so each session's history was written into a temporary directory and deleted on exit while `~/.zsh_history` sat untouched.
- Start zsh as a login shell, the way Terminal, Ghostty and Alacritty start it. `/etc/zprofile` never ran before, which on macOS is where `path_helper` builds `PATH`.
- Stop terminals inheriting an agent session. The environment was already scrubbed of Sikemux's own markers so a terminal could not wear the identity of whatever launched the app, but a coding agent's markers passed straight through — including a messaging socket and token, which handed every new shell the parent session's credentials.

## Settings

- One list of project folders. Pinned projects and discovery roots were two lists doing one job; that difference is a checkbox now. Tick **index itself** and a folder is offered as a project in its own right, on top of whatever its depth finds beneath it. Existing folders carry over, and one that was both keeps its depth instead of appearing twice.
- The panel follows the rest of the application. It was set in monospace throughout, which is why it read as a separate program, and its structural regions were rounded like cards, which nested boxes three deep.

## Appearance

- Flat surfaces throughout: no drop shadows, and no gradients that were not drawing something.

## Upgrade note

zsh no longer reports its working directory or exit codes to Sikemux, because that reporting is what required taking over `ZDOTDIR`. bash, fish and PowerShell are unaffected — they hook through an rc file or an init command and never take over a variable your configuration reads.

Any shell history from an earlier 0.3.x build was written to a temporary directory and is not recoverable. History written from this build onwards lands in your real history file.

The published automatic-update feed continues to target Apple Silicon macOS.

For the complete patch history, compare [`v0.3.1...v0.3.2`](https://github.com/nodelike/sikemux/compare/v0.3.1...v0.3.2).
