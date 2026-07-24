# Contributing to Sikemux

Thanks for taking the time to contribute. Sikemux is a Tauri + Rust + React desktop app; this guide gets you from a clean clone to a green PR.

## Getting started

**Prerequisites:** [Rust](https://www.rust-lang.org/tools/install) (stable), Node.js 22+, and pnpm 10.33.0 (the version pinned in `package.json`). macOS bundles require Xcode; Windows development requires Microsoft C++ Build Tools and WebView2. Published releases currently target Apple Silicon, while Windows support is validated in CI as an NSIS installer.

```bash
git clone git@github.com:nodelike/sikemux.git
cd sikemux
pnpm install
pnpm tauri dev      # hot-reload Vite + Tauri on macOS or Windows
```

## Project layout

| Path             | What lives there                                                       |
| ---------------- | ---------------------------------------------------------------------- |
| `src/`           | React UI — components, Zustand state, editor, terminal, themes, keymap |
| `src/api/`       | Thin wrappers over Tauri `invoke` commands                             |
| `src-tauri/src/` | Rust core — PTY, git, LSP, fs watchers, AWS & Rundeck clients          |
| `scripts/`       | Icon pipeline and platform release tooling                             |

## Before you open a PR

Run the same checks CI does and make sure they pass:

```bash
make check            # all formatting, lint, typecheck, frontend test, and Rust gates
make test-coverage    # truthful all-source frontend coverage report
pnpm build            # production frontend build
```

`make check` runs Prettier in check mode, ESLint, TypeScript, frontend tests with `NODE_ENV=test`, `cargo fmt --check`, Clippy with warnings denied, Rust tests, and credential-free release-tooling checks. These are the same quality gates enforced by CI.

Release tooling supports two explicit modes. The default community mode requires the Tauri updater private key but no Apple membership and produces an updater-signed, ad-hoc code-signed release. `RELEASE_NOTARIZED=1` additionally requires a Developer ID and Apple notarization credentials and enforces Gatekeeper and stapled-ticket verification.

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
- Your operating-system version and the Sikemux version (shown in the side rail).
- Logs or screenshots where relevant.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
