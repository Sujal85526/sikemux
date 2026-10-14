# Where Sikemux should aim — research synthesis, 2026-10-14

Research passes: the 9 linked posts and article, the Anthropic Scion article + HN, a competitor map
(~45 products), source control / review futures, agent-usage futures, business models, an inventory of
Sikemux itself, and a second round on T3 Code and herdr / Herdr UI, the open-model vertical, always-on
cloud machines, and Amoeba. Many funding/ARR numbers come from trackers and secondary blogs; treat them
as approximate.

---

## 1. What the links are actually saying

| Post | Signal |
|---|---|
| Owen Gretzinger: "is anyone building a good cloud agent platform" + screenshot of T3 Code at 62 GB, 30 GB swap | Laptops have hit a physical ceiling for agent fleets (client app + the dev servers agents spawn). Replies were wall-to-wall vendor pitches (Devin, Factory Environments, Amp orbs, Omnara...). |
| Bruno Santos: tried Orca, T3 Code, many GUIs, keeps going back to herdr | Speed and lightness decide GUI-vs-TUI. Winning screen: agent ↔ worktree ↔ PR → CI → merge → deploy on one card. |
| Fabien Penso: Herdr UI release (Teleport worktrees to/from cloud, SSH devices) | Native Rust/GPUI client for herdr: browser annotate → agent, diff notes → agent, per-machine CPU/mem, plan-usage meter. Teleport moves a worktree *with running programs and agent sessions* between hosts. No chat UI. |
| Elias Stråvik: herdr-projects | Coordinator that never works itself; workers in worktrees; blind reviewer with a rubric the maker never sees; PR ratchet; "needs you" board. |
| Rafal Wilinski: Runlayer "software factory" | Work starts from signals (calls, Slack, red CI, pins on prod via Agentation) not prompts; sandbox → evidence (before/after, video) → adversarial review → babysitter loop → automerge → QA fuzzer → digest. 91 PRs merged by one agent in 24h. New bottleneck: humans knowing what shipped. |
| Anthropic: Redesigning source control (Scion) | 2.5k → 30k merges/day. Server-side commits, lock-free CAS landing, no merge queue, fix conflicts after the fact, review by *intent* not lines. Explicitly leaves "agents conflicting with each other locally" unsolved. |
| Karpathy: the funnel | 0.2% of people live in the agent world; at the frontier "human review and comprehension are starting to fall behind." |
| Julius (T3 Code): cross-env orchestration | An agent on the laptop delegates a subagent to "box", server-to-server, with lineage. |
| DHH: "every developer needs an AI shed" | Always-on box on tailscale runs the (herdr) agents; laptop and phone are windows; close the lid without breaking anything. Most-requested addition in replies: a "what finished, what's running, what needs me" handoff. |

**The two currents underneath all of it**

1. **The agent runtime is leaving the laptop.** Daemon + thin clients (herdr, shed, Teleport, T3 box, every cloud vendor).
2. **The bottleneck is now human attention and trust, not agent throughput.** Intent review, evidence, blind reviewers, gates, digests, "needs you".

---

## 2. The market and who Sikemux actually competes with

Parallel sessions + worktree per task + diff review + browser pane + phone remote + notifications is now
commodity. 100+ apps do it; Orca hit ~90k stars giving it away under MIT; vibe-kanban and Terragon died
with no business model.

There are two different verticals, and Sikemux is only in one of them:

- **Single vendor, single model family.** Claude Code desktop, Codex in the ChatGPT app, Cursor 3, Copilot
  app, Antigravity. Rich and free with the plan, but they only run their own agent. They take people who
  will only ever use one vendor; that person is not Sikemux's user.
- **Every harness, every model.** The user picks the agent (Claude Code, Codex, OpenCode, Hermes, Pi, Grok,
  OMP, Muse...) and the model (frontier, open, local) per task. This is Sikemux's vertical.

**Direct competitors in that vertical:** T3 Code and herdr + Herdr UI (details in section 9). Behind
them: Orca, cmux, Conductor, Superset, JetBrains Air, Zed (ACP). Amoeba competes with the future Team tier,
not with Sikemux today (section 11).

---

## 3. Where Sikemux stands against T3 Code and herdr

**Sikemux is ahead on**

- **Native chat for every harness** with steering and rewind. herdr and Herdr UI have no chat at all
  (terminal-screen scraping for state). T3 has chat but runs it through an Electron app with known memory
  blowups (63 GB after sleep, 21 GB GPU leak) and is slower than Codex alone on the same task (#695).
- **Weight and stability:** 16 MB native-feeling app against Electron (T3) and a GPUI painter its author
  says "can consume significant CPU" (Herdr UI).
- **Phone app over iroh** with host approval, no open ports, no tunnel, no environment cap. herdr has no
  first-party phone app; T3 Connect is a Cloudflare tunnel with a 3-environment cap on free accounts.
- **The core already keeps agents alive** across window quit and app updates.
- **Ops context agents can use:** Jira, Slack, SigNoz, AWS, Rundeck, DB client, three code hosts; iOS
  Simulator tools; notch island; on-device dictation; encrypted shared chats.
- **Many agents in one checkout**, on purpose (both rivals default to worktrees).
- **Named agents, @mentions, agent-to-agent** shipped (ADR 0012): spawn/send/read/wait, questions that go
  to the lead first, a board per project, workers listed under their lead on the rail and phone. herdr has
  no parent/child tracking; T3 V2 has `delegate_task` and lineage, so this lead is narrow.

**Sikemux is behind on**

- **Multiple machines.** herdr has `machine add` over SSH; Herdr UI has Devices, Smart Dispatch, Teleport
  (worktree + running commands + agent sessions moved between hosts), Coder/Daytona/Railway cloud
  devices; T3 has one server per machine with clients attaching to many, plus cross-machine
  `delegate_task`. Sikemux's phone already keeps several hosts, but the Mac app talks only to its own
  core.
- **PR loop.** T3: multi-host PR pages, guided reviews, agents woken on checks/reviews/conflicts. Herdr UI:
  orchestrator tab that dispatches issues to agents, reviews and merges PRs. Sikemux's board Auto already
  opens the PR, waits for CI, gets one fix from the agent and merges, but never feeds review comments back.
- **Automations:** T3 has scheduled and webhook tasks and auto-resume after a usage-limit reset. Sikemux
  moves a chat to another signed-in account at a limit, but has no schedules, webhooks or resume at reset.
- **Outside agents driving it:** T3 exposes an MCP server with OAuth so ChatGPT or Claude can drive threads;
  herdr's whole CLI and socket API are scriptable, which is why it has ~1,700 community plugins.
- **Distribution and openness:** herdr 43.8k stars (Apache-2.0, $6M seed from Bessemer/YC, one founder),
  T3 27.4k stars (MIT, ~3.5k stars/month), both releasing every few days. Sikemux is FSL and absent from
  every public comparison found.
- **Reach:** herdr and T3 run on Linux and Windows; herdr lists 23+ agents.

---

## 4. Thesis

> **Sikemux is the control room for your agents: every harness, every model, every machine you own, and
> one place that tells you what needs you and why to trust what they did.**

Don't fight on parallelism or panes; that's free everywhere. Fight on three things:

1. **Every harness, every model** — not just running any CLI (herdr, Orca do that) but owning the model
   layer underneath them.
2. **Where agents live** — your hosts, not the laptop, without SSH config or tunnels.
3. **How a human stays in charge of 20 of them** — attention, provenance, evidence, undo.

All three build on things only Sikemux has: the core daemon, native drivers for many harnesses, the
provider key vault, iroh, the shared checkout, the phone and notch.

---

## 5. What to focus on, ranked

### 1. Sikemux Host — the shed, without the setup
Run the core headless on Linux or a spare Mac mini, install with one command, join it to the account with
a join ticket. The Mac app and the phone become clients of **several hosts**, each shown as a card with
CPU/memory and its agents. Agents keep working when the lid closes.
- **First blocker: the core can't start a chat on its own.** Launch commands and projects arrive only from
  the Mac app's `PublishWorkspace` and live in memory; agent accounts are managed by the app; host
  sign-in, owner setup and pairing approval are local-only. Move launchers, projects and agent accounts
  into the core, add a sign-in and pairing approval that work without a window, then the Linux bits
  (systemd unit in place of the Aqua-only LaunchAgent, `Platform::Linux`, host info, tests on Linux; the
  core already passes `cargo check` on Ubuntu).
- **Phone first.** The phone already pairs with several hosts and shows a card per host, so Host can ship
  to phones before the Mac app becomes a multi-host client, which is the bigger job (one local socket
  today, and git, previews and files assume a local disk).
- iroh means no open ports, no Tailscale, no SSH config: simpler than herdr's `machine add`, and no
  environment cap like T3 Connect. Ship this before Herdr Cloud leaves its waitlist.
- Agent logins happen **on the host**, with the login URL/code relayed to the Mac or phone. Never copy
  `~/.claude` or Keychain credentials across (Anthropic forbids intermediating credentials).
- Next: move a project and its live agents between hosts (Teleport), cross-host `agent_spawn` with
  lineage, and "send this to the host with spare cores".
- Answers Owen's memory wall: dev servers and builds run on the box.
- Cloud plan in section 7.

### 2. Every harness, every model — own the model layer
herdr and Orca run any CLI but know nothing about models. T3 brings your subscriptions but has no
open-model or local story. JetBrains Air supports local models through a hand-edited JSON file. Nobody
ties keys, coding plans and local models together and configures each harness for them. Sikemux already
has half of it: `src-tauri/src/model_providers.rs` keeps keys for OpenRouter, Baseten, Together,
Fireworks, Groq, Cerebras, DeepSeek, Moonshot, Mistral and Vercel in the Keychain and hands them to
OpenCode, Pi and OMP as environment variables. The catalogue is a constant in code, nothing sets
`ANTHROPIC_BASE_URL` or a Codex provider, and there are no coding plans or local runners yet.

Ranked:
1. **Connections that know each plan, per agent.** Add the coding plans (z.ai GLM Coding Plan, OpenCode Go,
   Synthetic, MiniMax, Kimi Code, Ollama Cloud) and local runners (Ollama, LM Studio), then write each
   harness's own config: Claude Code via `ANTHROPIC_BASE_URL` to z.ai / MiniMax / Kimi / LM Studio, Codex
   via its provider config or `--oss`, OpenCode/Pi/OMP via env. One model picker per agent.
2. **One meter across plans, with fallback.** Every plan now uses the same 5-hour + weekly windows. Show
   them all with pay-per-token spend, and offer "this plan is out, continue on X". Builds on the existing
   limit rotation.
3. **Cheap models for helpers, frontier for building.** Scouts, reviewers and spawned workers default to a
   cheap open model; the main builder keeps the frontier one. Only a cross-harness app can do this.
4. **A tool-call check per provider and model.** The same open weights behave differently per provider
   (why OpenRouter built Exacto and Moonshot published a vendor verifier). A short probe before marking a
   model "works with agents" answers the top open-model complaint, and nobody ships it.
5. **One-click local.** Detect Ollama or LM Studio, suggest a model by RAM (Qwen3.6-27B for 48–64 GB,
   Qwen3-Coder-Next or Qwen3.6-35B-A3B for 64 GB+), pull it, probe it, wire it in. Small audience, strong
   for privacy and marketing.
6. **A no-account first run** through OpenCode's free models or OpenCode Go. Use OpenCode; don't build a
   harness.

Why it is real: Chinese open models are about half of OpenRouter tokens; Hermes (1.99T tokens/day),
Kilo, Cline, pi and omp all outrank Codex on OpenRouter; open models cost a quarter to a sixth of frontier
and sit roughly 6 points behind on overall indexes. People switch for cost, rate limits, privacy and
vendor-policy risk. Pitfalls: model names and plan limits change monthly (keep the catalogue as data),
plans pause sign-ups when GPUs run out, don't publish benchmark claims without your own runs, and offer
US/EU-hosted copies of Chinese weights for companies.

### 3. Many agents, one checkout, every line knows who wrote it
Nobody has this. Anthropic's article leaves it open. Sikemux has none of it yet: the chat drivers parse
Edit/Write/apply_patch only to draw tool rows, and the file watcher knows nothing about agents.
- **Hunk attribution, live:** the core already sees every Edit/Write/apply_patch; add the file watcher for
  Bash edits (marked unattributed). The git panel shows a lane per agent.
- **Safe commit tool:** commit only that agent's hunks through a private index, move `main` with a
  compare-and-swap, retry on top if it moved. Then the harness can refuse `add -A`, `commit -a`, `stash`,
  `reset --hard` from agents. AGENTS.md's rule becomes enforced, not prompted.
- **Collision warnings before commit:** two agents in one file/hunk → both told via agent_send; short
  leases on lockfiles, migrations, generated code. Block a stale full-file write that would erase
  another agent's edit (the failure every shared-checkout write-up names).
- **Per-agent undo:** snapshot each agent's turns under a private ref so "undo everything Otter did since
  14:02" leaves the others alone. Covers what Claude's /rewind misses (bash, other CLIs).
- **Provenance:** commit trailers (agent name, CLI, model, chat id, card) and a click from any commit or
  blame line to the transcript turn. Emit Agent Trace records. (Agent identity only — no Claude co-author
  lines.)

### 4. The decision inbox (one surface for rail, notch and phone)
Replace notification streams with a ranked queue: blocked/asking agents first, changes to review next,
finished work, then progress. Batch on your schedule; show a work-in-progress count; write a handoff note
when an agent stops. A "while you were away" digest on open.
- Most inputs exist: unread and last-active (`seen.rs`), questions with assumptions, pending push items
  with away detection, board cards with owners, and rail, notch and phone reading the same core state.
  The queue is one more core view over them. `browser_record` saves to `~/Movies/Sikemux` and isn't
  attached to any turn or card yet.
- Review by **intent + evidence**, not lines: what was asked, what the agent says it did, risk class
  (comment/test-only vs logic vs migration/protocol/server), checks that ran, and the browser recording or
  before/after screenshot it took (browser_record already exists). Diff last.
- Rules escalate the risky classes; routine changes with evidence pass. Approve / revert / steer from the
  phone in one tap.
- T3 is investing heavily in PR review; the difference here is local attribution plus evidence, across
  harnesses, before anything is a PR.

### 5. Make review cross-vendor, on top of agent-to-agent
- ADR 0012 has shipped. Left: Linear cards (only Jira feeds the board), and the adapter for agents outside
  Sikemux, deferred on purpose. Agent-to-agent across hosts waits on focus 1.
- One button: "Claude builds, a GPT or open model attacks it" with a rubric the builder never sees.
- **Definition-of-done gates:** checks an agent must pass before its card can move (tests, `pnpm check`
  slices, hooks that reject and say why). Huntley: enforcement beats rules files.
- After landing on main: run affected checks; if main goes red, bisect to the agent and commit and tell
  that agent. "Revert Otter's last commit" without touching anyone else.

### 6. Close the parity gaps against T3 and Herdr UI, cheaply
- PR babysitter: board Auto already waits on CI and gets one fix; extend its reviewing step to feed review
  comments to the agent, reply and re-request review.
- Auto-resume when a usage limit resets (the usage meter already knows the reset time), then
  routines/schedules and webhook triggers on your own host.
- An MCP/CLI surface outside agents can drive (T3's `/mcp` with OAuth). Plugins stay compiled in
  (ADR 0002); this is about being drivable, not a marketplace.
- Signals → board: Slack threads, Jira/Linear tickets, red CI become cards agents pick up.
- Finish #71 (install/sign-in in app) and #106 (survive Wi-Fi drops).
- Publish memory and CPU numbers with 20 agents open; it is T3's weakest point and herdr's open complaint.

### Stop or don't start
- Running your own cloud fleet, or reselling inference or coding plans.
- A skills marketplace (90k+ low-quality skills on skills.sh; malware via ClawHub).
- A standalone AI review SaaS (CodeRabbit, Graphite/Cursor own it); keep review inside the app.
- Worktree wars and Best-of-N as the headline; keep worktrees as an option for the rare real conflict.
- Leading with the notch or the phone remote alone; keep them as the delivery surface for the inbox.
- Building your own agent harness; drive OpenCode, Pi, Hermes and the rest.
- The GPUI rewrite (#115) stays parked; bounded memory matters more than the renderer right now.

---

## 6. Products to add

| Product | What | Price |
|---|---|---|
| **Sikemux** (Mac, Linux) | The whole local app, every harness and model, unlimited agents, phone on one host, push | Free forever: it's the distribution |
| **Sikemux Host** | Headless core for a Linux box / Mac mini / VPS; one-line install; one-click into your own Hetzner or DigitalOcean | Free for one host |
| **Sikemux Pro** | Multiple hosts per account, moving work between hosts, synced settings/skills/provider config, history search across machines, routines on your hosts, the cross-plan meter | ~$10/mo or $96/yr (Termius model: ~$4M on ~2M users charging for sync + devices) |
| **Sikemux Team** | Live shared sessions (join, steer, take over at a checkpoint), shared skills and provider setups, team inbox, roles, central billing | ~$20/seat/mo — the most likely thing a company pays for |
| **Later: Sikemux Shed** | A managed always-on box on Fly Sprites, opt-in, card required | ~$25/mo for 120 active hours, $0.20/h after (section 7) |
| **Later: review check** | The same intent + evidence + adversarial review as a GitHub/Bitbucket check for teams | Team add-on |
| **Later: pin-to-agent widget** | A small script for staging/prod pages: click an element, leave a note, it lands as a card for your agents (Agentation-style) | Team add-on |

Referral deals with inference providers (z.ai pays in credits, OpenRouter has no affiliate programme) are
for co-marketing, not income. Optional later: require Pro/Team for commercial use above ~10 people once
there is real usage at companies.

---

## 7. Cloud: should users get VMs for an always-on machine?

**Not first. Phase it.**

The tools closest to Sikemux (herdr, Herdr UI, T3, Superset, Cursor's "My Machines") connect machines the
user already owns. The funded seat-priced products (Conductor, cmux, Amp, Factory) host. Anthropic and
OpenAI now include cloud VMs free with the plan, so hosted compute for Claude/Codex users competes with
free. Herdr Cloud (waitlist) only links your own machines; it does not host agents.

**Phase 1 — bring your own box (now).** The Host in focus #1. "Use this Mac mini as a shed" covers
macOS/iOS work. Prerequisite: the Linux core (#10).

**Phase 2 — one click into the user's own cloud account.** Hetzner project token or DigitalOcean OAuth,
cloud-init installs the core with a join ticket. The token stays in the Mac Keychain, used once, never sent
to the accounts server. Default to Hetzner CPX32 (4 vCPU / 8 GB, about €36/mo after the 2026 price rises).
Optional "sleep when idle": snapshot and delete through the user's token, recreate on wake. Sikemux pays no
compute bill, handles no abuse or KYC, needs no extra vendor terms, and each user keeps their own IP.

**Phase 3 — managed "Sikemux Shed", only on demand.** Trigger: waitlist at ~10% of weekly active desktop
users, or proof people will pay.
- Run it on **Fly Sprites**, which bill CPU and memory actually used ($0.0385 per CPU-hour,
  $0.021875 per GB-hour), checkpoint in about a second, and don't meter bandwidth. Agents spend most of
  their time waiting on the model, so this is the only billing shape that fits. E2B/Daytona/Vercel bill
  reserved capacity (a 4 vCPU / 8 GB box is ~$0.33/h busy or not).
- Price ~$25/mo for 120 active hours of 4 vCPU / 8 GB + 50 GB, $0.20/h after, user-set hard cap, card
  required, no free tier. Cost per box ~$12 (light) to ~$20 (heavy compiles): 20–50% gross margin.
- Before launch: accept Anthropic's Commercial Terms (preinstalling or running Claude Code in hosted
  sandboxes requires them); make the accounts server wake a sleeping box when a phone connects; check that
  the core's open connections don't stop Sprites from ever sleeping; DPA and subprocessor list; mining and
  egress guards.

**Never — own fleet.** 2026 RAM prices, idle-cost exposure and hypervisor work cost more than the margin.

Logins on remote boxes: Claude Code with the user's own subscription on a box they control is allowed
("including where a platform hosts Claude Code"); sign-in must go through Anthropic's flow. Codex supports
`codex login --device-auth` (beta, enabled in ChatGPT security settings first).

---

## 8. Platform risk rules

- Never touch model credentials; launch vendors' own installers and logins (#71's stance is right).
- Keep the terminal transport fully working for every agent. If Anthropic revives metering of
  `claude -p` / stream-json for third-party apps, chat panes are what gets hit.
- Apply to OpenAI's "Sign in with ChatGPT" plan-usage programme for coding tools (live since 2026-09-29;
  Conductor, Warp, Amp, OpenCode, Hermes are in). It's permission and a listing.
- Support API keys, coding plans, open and local models alongside subscriptions; that is the hedge and the
  vertical at once.
- Say "runs Claude Code"; never put Claude/Anthropic in names or marks.
- Security worth doing while keeping the YOLO default: agent browser tabs on their own profile with no
  user cookies unless granted per site (agent browser + your sessions = the "lethal trifecta"), an audit
  log of agent-to-agent messages, per-turn snapshots.

---

## 9. T3 Code and herdr / Herdr UI in detail

**T3 Code** (pingdotgg/t3code, Theo and Julius)
- 27.4k stars, MIT, Electron + Node server (Effect-TS), React web app at app.t3.codes, Expo phone apps.
  Growing ~3.5k stars/month; nightly builds daily, a stable release every week or two.
- One server per machine; web, desktop and phone clients attach over authenticated RPC. Reach it directly,
  over Tailscale, SSH, or T3 Connect (Cloudflare tunnel + Clerk; free accounts capped at 3 environments).
- Harnesses: Codex (app-server), Claude (Agent SDK), Cursor SDK, Grok, OpenCode, Antigravity, Pi, Muse,
  ACP registry. Bring your own subscription; open models only through OpenCode/OpenRouter/Pi.
- Orchestrator V2 (event-sourced on SQLite, nightly only): `delegate_task` to any provider or machine,
  lineage view, server-side steer/queue, fork and rollback, scheduled and webhook tasks, auto-resume after
  limits.
- Heavy PR investment: multi-host PR pages, stacks, guided reviews, PR watches. Agent-drivable browser,
  including one running on the remote server. MCP server for outside agents.
- Weak spots: memory (63 GB after sleep, 21 GB GPU leak, idle server growth), slower than Codex alone
  (15–20 min vs 4.5), Claude usage 3–5x higher than the native app (closed), telemetry on by default
  despite promising otherwise, V1→V2 migration loses checkpoints, no paid tier.

**herdr** (herdrdev/herdr, Can Celik)
- 43.8k stars, Apache-2.0 (was AGPL until July), Rust + vendored libghostty, ~1.4M installs, YC F26,
  $6M seed (Bessemer lead; Tobi Lütke, Dane Knecht among angels). Mostly one founder.
- A background server owns the PTYs; thin TUI clients attach; newline-JSON socket API and a CLI that is
  also the plugin API. ~1,700 community plugins (34 with 100+ stars): phone/web clients, reviewers,
  coordinators, browsers.
- 23+ agents detected by reading the bottom of each pane's screen. No chat, no ACP, no model layer, no
  built-in browser or review. Worktrees first-class.
- `machine add` over SSH since 0.9.0; agents can't see agents on other machines yet. Herdr Cloud
  (waitlist) will link your own machines with end-to-end encryption, not host agents.
- Complaints: lag with many agents, server dying after the last client detaches, SSH drops killing remote
  panes, no auto-naming.

**Herdr UI** (penso/herdr-gpui, Fabien Penso — not affiliated with herdr)
- 1.3k stars in three weeks, Apache-2.0, Rust on pre-release GPUI, macOS/Linux/Windows. A side project.
- Paints herdr's terminal cells natively. Review Changes with line notes to the agent, checkpoints,
  WebKit browser tabs with annotate-to-agent, plan usage meter, Orchestrator tab (issues/PRs → dispatch,
  review, merge).
- Teleport: worktree (git bundle), uncommitted changes, layout, running commands and agent sessions
  (Claude Code, Codex, opencode, pi/omp, Copilot) moved to another host; others get a handoff note.
  Smart Dispatch to the host with spare cores; Devices overview; Coder/Daytona/Railway cloud devices.
- No chat, no phone app. Admits its cell painter can use significant CPU.

**What they'll likely ship in 3–6 months:** T3 V2 to stable with store phone builds, more PR review,
fleet management across machines, more providers. herdr: Herdr Cloud, agents that see each other across
machines, more clients beyond the TUI, Windows parity, toward 1.0. Herdr UI: device setup, cloud devices,
moving single panes between devices.

**The five moves that beat both:** Host over iroh before Herdr Cloud (focus 1); the model layer neither
has (focus 2); native chat for every harness, kept fast and bounded on memory (their weakest points);
attribution + inbox + evidence (focus 3–4) against T3's PR-centric review; agent-to-agent (already
shipped on one host) extended across hosts with lineage, before T3 V2 reaches stable.

---

## 10. Claude Code desktop and the other single-vendor apps

Not the main competitor: they sit in the single-vendor vertical. Worth watching because they set user
expectations for free (browser pane, iOS Simulator pane, SSH, cloud sessions, cross-session messaging,
Remote Control, Dispatch) and because Anthropic's policy on third-party use moves often (banned in
February, reinstated in May, metering paused in June, plan credits added in October).

---

## 11. Amoeba (useamoeba.com)

Not an always-on cloud machine. A free, early-access multiplayer IDE (VS Code fork on Electron, 573 MB DMG,
~1 GB AppImage) where teammates share a live session, each with their own agent in a lane, coordinated by a
hosted server ("Brain") that stores sessions, plans, locks and transcripts with keys Amoeba holds.
Agents run on each person's own laptop; when a laptop closes or hits a usage limit, a teammate takes over
at a checkpoint. Claude Code and Codex via hooks + MCP, plus its own harness with 180+ models; managed
models at cost + 5%. About 5,400 installer downloads, ~540 Discord members, no funding found.

It competes with the planned **Team** tier, not with single-player Sikemux. Sikemux is ahead on keeping
agents alive with the lid closed, the phone, native drivers for many harnesses, the agent-driven browser,
weight, and privacy (P2P and sealed shared chats vs a vendor-readable server).

Ideas worth taking for Team: show whose account pays before a turn runs; take over at a safe checkpoint
with one winner if two click; overlap checks plus advisory locks on exact paths; memories pinned to a file
that go stale when the code moves; approvals enforced on the machine that runs the action; viewer /
commenter / editor / owner roles.

---

## 12. Go-to-market

- X: short screen recordings of what rivals can't show (two vendors' agents talking, an open model
  reviewing Claude's work, the inbox on the phone, closing the lid while the shed keeps going).
- Show HN for the Host/Linux launch, not before.
- Comparison pages: vs T3 Code, herdr, Orca, Conductor, cmux.
- Phone app in the App Store catches "Claude Code / Codex mobile" searches; word the listing carefully.
- Discord for retention.

## 13. Website implications

If the Host, the model layer, the inbox, attribution or Team ship, sikemux.com needs new copy and a
pricing page. The site can already claim browser annotate-to-agent and native chat for many harnesses.

## 14. Main sources

- Posts: [owengretzinger](https://x.com/owengretzinger/status/2109846365065052351),
  [brunogsantos](https://x.com/brunogsantos/status/2109964126810517775),
  [fabienpenso](https://x.com/fabienpenso/status/2109881742089941348),
  [eliasstravik](https://x.com/eliasstravik/status/2109777235687202876),
  [rafalwilinski](https://x.com/rafalwilinski/status/2109940991868252302),
  [karpathy](https://x.com/karpathy/status/2109361546505966046),
  [jullerino](https://x.com/jullerino/status/2107976989810524309),
  [dhh](https://x.com/dhh/status/2106755814421565495)
- [Anthropic: Redesigning source control](https://www.anthropic.com/engineering/redesigning-source-control),
  [HN thread](https://news.ycombinator.com/item?id=50073633)
- [Anthropic: Managed Agents](https://anthropic.com/engineering/managed-agents),
  [Huntley: agency](https://ghuntley.com/agency/),
  [Semgrep: The End Is Nigh for Code Review](https://semgrep.dev/blog/2026/end-is-nigh-for-code-review)
- T3 Code: [repo](https://github.com/pingdotgg/t3code), [site](https://t3.codes),
  [remote internals](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md)
- herdr: [repo](https://github.com/herdrdev/herdr), [socket API](https://herdr.dev/docs/socket-api/),
  [plugins](https://herdr.dev/docs/plugins/), [seed](https://herdr.dev/blog/herdr-raised-a-seed/),
  [cloud](https://herdr.dev/cloud/)
- Herdr UI: [repo](https://github.com/penso/herdr-gpui), [site](https://herdrui.dev)
- [Amoeba](https://useamoeba.com/), [pricing](https://useamoeba.com/pricing), [docs](https://useamoeba.com/docs)
- Open models: [Artificial Analysis open-weights launches](https://artificialanalysis.ai/articles/recent-open-weights-model-launches),
  [OpenRouter apps](https://openrouter.ai/apps), [OpenRouter Exacto](https://openrouter.ai/blog/announcements/auto-exacto/),
  [Kimi Vendor Verifier](https://kimi.com/blog/kimi-vendor-verifier), [z.ai Coding Plan](https://docs.z.ai/devpack/overview),
  [OpenCode Go](https://opencode.ai/docs/go/), [Synthetic](https://synthetic.new/pricing),
  [LM Studio with Claude Code](https://www.lmstudio.ai/docs/integrations/claude-code),
  [Ollama on MLX](https://registry.ollama.ai/blog/mlx),
  [JetBrains Air local models](https://blog.jetbrains.com/air/2026/07/what-s-new-air-gets-more-agents-local-models-and-java-kotlin-code-intelligence/),
  [Stack Overflow 2026 AI survey](https://survey.stackoverflow.co/2026/ai/data)
- Cloud: [Fly AI sandbox pricing](https://fly.io/learn/ai-sandbox-pricing/), [Sprites](https://fly.io/sprites),
  [Amp orb costs](https://ampcode.com/docs/orbs/sizes-and-costs), [Conductor pricing](https://www.conductor.build/pricing),
  [Factory Droid Computers](https://docs.factory.ai/droid-computers/overview), [exe.dev](https://exe.dev/),
  [Hetzner 2026 price rise](https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/),
  [Codex auth](https://learn.chatgpt.com/docs/auth)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
  [Agent SDK plan usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Superset pricing](https://superset.sh/pricing), [Termius pricing](https://termius.com/pricing),
  [vibe-kanban shutdown](https://vibekanban.com/blog/shutdown),
  [Mac coding agent apps comparison](https://rywalker.com/research/mac-coding-agent-apps)
- [Agent Trace](https://agent-trace.dev/), [git-ai](https://usegitai.com/docs/get-started/how-git-ai-works),
  [GitButler parallel agents at Trigger.dev](https://trigger.dev/blog/parallel-agents-gitbutler)
