<div align="center">

# Sikemux

**A GUI terminal multiplexer for people who live in the terminal — but want their editor, git, cloud, CI/CD and API tooling in the same window. Built with Tauri + Rust + React.**

![Sikemux editor](public/screenshots/project-editor-view.png)

[![macOS](https://img.shields.io/badge/macOS-11%2B%20Apple%20Silicon-000?logo=apple&logoColor=white)](#installation)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Latest release](https://img.shields.io/github/v/release/nodelike/sikemux?display_name=tag)](https://github.com/nodelike/sikemux/releases/latest)

</div>

---

## Features

### 🗂 Projects — editor, terminal, git & agents in one session

A project session bundles five views (`Files`, `Term`, `Git`, `Agents`, `Search`) over a single working directory.

- **Code editor** — CodeMirror 6 with syntax for JS/TS/JSX, Python, Rust, Go, HTML, CSS, JSON, YAML, Markdown (+ legacy modes), inline **LSP** hover / go-to-definition / peek, git gutter, find & replace, indentation guides, and virtualized rendering for big files.
- **Diff & merge** — side-by-side diff editor and a three-way merge review for conflict resolution.
- **File tree** — live filesystem watchers (no drift), create / rename / delete, and native drag-and-drop to move files or drop them in from Finder.

<table>
<tr>
<td width="50%"><img src="public/screenshots/project-term-view.png" alt="Terminal view"/></td>
<td width="50%"><img src="public/screenshots/project-git-view.png" alt="Git view"/></td>
</tr>
<tr>
<td align="center"><b>Integrated terminal</b> — xterm.js + WebGL, real PTYs via Rust, split panes, tabs, drag-drop paths.</td>
<td align="center"><b>lazygit-style git</b> — branches, staging, commits, diffs, merge, pull/push, current branch pinned on top.</td>
</tr>
</table>

### 🤖 AI coding agents

Run coding agents right next to the code they're editing. Sikemux auto-detects **Claude, Codex, Hermes, Pi and OpenCode** on your `PATH`, surfaces their past sessions, and lets you spin up several per project from the agent rail.

- Multiple concurrent agents per project, each in its own pane.
- Reads agent session histories so you can resume threads.
- **YOLO toggle** (`⌥Y`) to skip permission prompts when you trust the run.

![Agents view](public/screenshots/project-agents-view.png)

### ☁️ Cloud — an AWS console you actually keep open

A built-in AWS panel for the things you check all day, with one-click refresh so console changes show up instantly.

- **Cost & billing** explorer.
- **ECS** services & tasks with live **CloudWatch log tailing** (selectable/copyable while streaming).
- **EC2, Lambda, S3, SQS** browsers.

<table>
<tr>
<td width="50%"><img src="public/screenshots/cloud-aws-billing-view.png" alt="AWS billing"/></td>
<td width="50%"><img src="public/screenshots/cloud-aws-ecs-tasks-logs-view.png" alt="AWS ECS tasks & logs"/></td>
</tr>
</table>

### 🚀 CI/CD — Rundeck deploy center

Drive Rundeck without leaving the app: browse projects, fire jobs from a palette, and watch deployments stream **step-by-step progress and per-step output** in real time.

![Rundeck](public/screenshots/cicd-rundeck-projects-view.png)

### 🔌 API — Bruno workspace

Open your [Bruno](https://www.usebruno.com/) collections as first-class sessions and run requests with a keyboard-first flow.

- Request palette (`⌘P`) and environment palette (`⌥E`).
- Save with `⌘S`, send with `⌘↵`, scripting sandbox for pre/post hooks.

![Bruno](public/screenshots/api-bruno-pane-view.png)

### 🔐 SSH & ⌨️ Command sessions

Connect to SSH hosts (`⌥⇧S`) or open scratch command shells (`⌥S`) as their own multiplexed sessions.

### 🎨 Themes & chrome

- **9 built-in themes** — Aura, Ayu Dark, Tokyo Night, Catppuccin Mocha, Dracula, Gruvbox Dark, Nord, One Dark, Solarized Dark.
- **Custom theme editor** — tune interface, editor, syntax and the full 16-color terminal palette, then save your own.
- Frameless overlay title bar, adjustable **window transparency & blur** (macOS private API), and a distraction-free **Zen mode**.

### 🔄 And the glue

Tiling pane splits with vim-style focus movement, fuzzy session picker, live update notifications via the built-in **auto-updater**, and persisted layout across restarts.

## Keyboard shortcuts

| Key       | Action                               |     | Key              | Action                    |
| --------- | ------------------------------------ | --- | ---------------- | ------------------------- |
| `⌥S`      | Open / create a session              |     | `⌥\` / `⌥-`      | Split pane (row / column) |
| `⌥P`      | Open project                         |     | `⌥H/J/K/L`       | Move focus between panes  |
| `⌥⇧S`     | Connect SSH host                     |     | `⌥⇧H/J/K/L`      | Resize active pane        |
| `⌥A`      | Open AWS                             |     | `⌥Z`             | Zoom / unzoom pane        |
| `⌥B`      | Open Bruno workspace                 |     | `⌥W`             | Close focused pane        |
| `⌥1`–`⌥5` | Files / Term / Git / Agents / Search |     | `⌥Tab` / `⌥⇧Tab` | Cycle session / group     |
| `⌥[` `⌥]` | Prev / next window                   |     | `⌥Y`             | Toggle agent YOLO mode    |
| `⌘P`      | File / request palette               |     | `⌘⇧F`            | Global search             |
| `⌘,`      | Settings                             |     | `⌥T`             | Focus command terminal    |

## Installation

### Download (recommended)

Grab the latest `.dmg` from the [**Releases**](https://github.com/nodelike/sikemux/releases/latest) page. Published releases currently target **Apple Silicon** and require **macOS 11+**. Sikemux ships an auto-updater, so it keeps itself current after that. Intel Macs are not currently covered by the published updater feed.

### Build from source

**Prerequisites:** [Rust](https://www.rust-lang.org/tools/install), Node.js 22+, and [pnpm](https://pnpm.io/).

```bash
git clone git@github.com:nodelike/sikemux.git
cd sikemux
pnpm install

# Hot-reload dev (Vite + Tauri)
make dev            # or: pnpm tauri dev

# Production Apple Silicon .app + .dmg on an Apple Silicon host
make build          # or: pnpm build:mac

# Explicit local universal build (Apple Silicon + Intel; not the published feed)
pnpm build:mac:universal
```

Run `make check` for the full local quality gate: Prettier, ESLint, TypeScript, deterministic frontend tests, Rust formatting, Clippy, Rust tests, and credential-free release-tooling verification. `make test-coverage` reports coverage across all frontend TypeScript/TSX source, including files no test imports. `make run` launches an already-built release binary.

### Community releases without an Apple Developer membership

The updater and Apple Gatekeeper are separate trust systems. `scripts/release.sh` defaults to a **community release**: the updater archive is signed with the Tauri updater key and the app/DMG receive a structurally valid ad-hoc code signature. This supports in-app updates for the existing community installation flow, but fresh downloads are not Apple-notarized and macOS may require removing quarantine again. Keep the updater private key secure; clients reject archives that do not match the public key embedded in the app.

After joining the Apple Developer Program, set `RELEASE_NOTARIZED=1` plus the Developer ID and notarization environment variables. The same script then requires Gatekeeper assessment and stapled notarization tickets before publishing.

## Contributing

PRs and issues are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, project layout, and the checks to run before opening a PR.

## License

[MIT](LICENSE) © nodelike

---

<div align="center">
<sub><code>sike</code> + <code>mux</code> — built by <a href="https://github.com/nodelike">@nodelike</a></sub>
</div>
