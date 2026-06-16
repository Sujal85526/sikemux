# Contributing to Sikemux

Thanks for taking the time to contribute. Sikemux is a Tauri + Rust + React desktop app; this guide gets you from a clean clone to a green PR.

## Getting started

**Prerequisites:** [Rust](https://www.rust-lang.org/tools/install) (stable), Node.js 18+, and [pnpm](https://pnpm.io/). Building the macOS bundle requires Xcode command-line tools.

```bash
git clone git@github.com:nodelike/sikemux.git
cd sikemux
pnpm install
make dev            # hot-reload Vite + Tauri (or: pnpm tauri dev)
```

## Project layout

| Path | What lives there |
|---|---|
| `src/` | React UI — components, Zustand state, editor, terminal, themes, keymap |
| `src/api/` | Thin wrappers over Tauri `invoke` commands |
| `src-tauri/src/` | Rust core — PTY, git, LSP, fs watchers, AWS & Rundeck clients |
| `scripts/` | Icon pipeline and macOS build script |

## Before you open a PR

Run the same checks CI does and make sure they pass:

```bash
make tsc            # typecheck the frontend (pnpm tsc --noEmit)
make check          # cargo check the Rust core
```

- **Formatting** — the frontend uses Prettier (`src/.prettierrc`); Rust uses `cargo fmt`. Match the surrounding style.
- **Scope** — keep PRs focused. One feature or fix per PR is much easier to review.
- **No regressions** — keep things efficient and performant; if a change touches the editor, terminal, or git panes, verify the affected views still behave.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/) — the format already used in this repo:

```
feat(themes): add custom theme editor
fix(sessions): treat agent view as project-only
style(bruno): tighten sidebar row styling
chore(release): v0.1.20
```

Common types: `feat`, `fix`, `style`, `refactor`, `perf`, `chore`, `docs`. Scopes match the area you touched (`editor`, `git`, `aws`, `rundeck`, `bruno`, `terminal`, `themes`, …).

## Reporting bugs & requesting features

Open an [issue](https://github.com/nodelike/sikemux/issues) with:

- What you expected vs. what happened, and steps to reproduce.
- Your macOS version and the Sikemux version (shown in the side rail).
- Logs or screenshots where relevant.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
