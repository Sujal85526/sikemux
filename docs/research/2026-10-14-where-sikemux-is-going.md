# Where Sikemux should aim — research synthesis, 2026-10-14

Seven research passes: your 9 links, the Anthropic Scion article + HN, a competitor map (~45 products),
source control / review futures, agent-usage futures, business models, and an inventory of Sikemux itself.
Many funding/ARR numbers come from trackers and secondary blogs; treat them as approximate.

---

## 1. What the links are actually saying

| Post | Signal |
|---|---|
| Owen Gretzinger: "is anyone building a good cloud agent platform" + screenshot of T3 Code at 62 GB, 30 GB swap | Laptops have hit a physical ceiling for agent fleets (client app + the dev servers agents spawn). Replies were wall-to-wall vendor pitches (Devin, Factory Environments, Amp orbs, Omnara...). |
| Bruno Santos: tried Orca, T3 Code, many GUIs, keeps going back to herdr | Speed and lightness decide GUI-vs-TUI. Winning screen: agent ↔ worktree ↔ PR → CI → merge → deploy on one card. |
| Fabien Penso: Herdr UI release (Teleport worktrees to/from cloud, SSH devices) | Closest feature-for-feature rival: native Rust/GPUI, browser annotate → agent, diff notes → agent, per-machine CPU/mem, plan-usage meter. Teleport moves a worktree *with running programs and agent sessions* between hosts. Admits no real chat UI. |
| Elias Stråvik: herdr-projects | Coordinator that never works itself; workers in worktrees; blind reviewer with a rubric the maker never sees; PR ratchet; "needs you" board. |
| Rafal Wilinski: Runlayer "software factory" | Work starts from signals (calls, Slack, red CI, pins on prod via Agentation) not prompts; sandbox → evidence (before/after, video) → adversarial review → babysitter loop → automerge → QA fuzzer → digest. 91 PRs merged by one agent in 24h. New bottleneck: humans knowing what shipped. |
| Anthropic: Redesigning source control (Scion) | 2.5k → 30k merges/day. Server-side commits, lock-free CAS landing, no merge queue, fix conflicts after the fact, review by *intent* not lines. Explicitly leaves "agents conflicting with each other locally" unsolved. |
| Karpathy: the funnel | 0.2% of people live in the agent world; at the frontier "human review and comprehension are starting to fall behind." |
| Julius (T3 Code): cross-env orchestration | An agent on the laptop delegates a subagent to "box", server-to-server, with lineage. |
| DHH: "every developer needs an AI shed" | Always-on box on tailscale runs the agents; laptop and phone are windows; close the lid without breaking anything. Most-requested addition in replies: a "what finished, what's running, what needs me" handoff. |

**The two currents underneath all of it**

1. **The agent runtime is leaving the laptop.** Daemon + thin clients (herdr, shed, Teleport, T3 box, every cloud vendor).
2. **The bottleneck is now human attention and trust, not agent throughput.** Intent review, evidence, blind reviewers, gates, digests, "needs you".

---

## 2. The market in one paragraph

Parallel sessions + worktree per task + diff review + browser pane + phone remote + notifications is now
commodity. 100+ apps do it; Orca hit ~90k stars giving it away under MIT; vibe-kanban and Terragon died
with no business model. The labs shipped the same shape free with the plan: Claude Code desktop (browser
pane, iOS Simulator pane, SSH, cloud, cross-session messaging, Remote Control, Dispatch), Codex inside the
ChatGPT desktop app, Cursor 3 (Agents Window, Projects, self-hosted cloud agents, iOS remote), Copilot app,
Antigravity 2.0, JetBrains Air. Paid tiers that exist charge for the remote side: Conductor Pro $50
(cloud, multiplayer, iOS), Superset Pro $20, cmux Founder's Edition.

**Real threats, in order:** Claude Code desktop, Orca, ChatGPT/Codex app, cmux, Conductor, Cursor 3.
**Closest in spirit:** Herdr UI (native, multi-host, Teleport), T3 Code (cross-env agents, mobile).

---

## 3. What Sikemux already has that others don't

- **The background core is already a herdr-style daemon.** Shells and agents survive window quit and app
  updates. Everyone else is retrofitting this.
- **Native chat drivers for every vendor** (Claude, Codex, Muse native; OpenCode/OMP/Grok/Hermes/Pi via
  ACP) with steering and rewind. Competitors scrape terminals or support one vendor. Herdr's author says
  chat is hard for them.
- **Many agents in one checkout, on purpose.** The market defaults to worktrees; Scion, GitButler and
  Trigger.dev show shared state is where things are going, but nobody has made it safe locally.
- **Named agents + @mentions + ADR 0012** (agent_send, board, ask-the-lead): Anthropic's equivalent is
  experimental and Claude-only.
- **Ops context built in and agent-usable:** Jira, Slack, SigNoz, AWS, Rundeck, DB client, three code hosts.
- **iroh P2P phone** with host approval (no vendor relay), notch on core state, 16 MB native-feeling client.

**Where it is behind:** no always-on/remote host story (biggest gap given DHH/Owen/Teleport); no PR
babysitter loop; no routines/schedules; single-player; Linux not first-class (#10), no Windows; onboarding
(#71) and network resilience (#106) epics open; agent_* tools not built yet.

---

## 4. Thesis

> **Sikemux is the control room for your agent fleet: every vendor, every machine you own, one place that
> tells you what needs you and why to trust what they did.**

Don't fight on parallelism or panes; that's free everywhere. Fight on the two currents: **where agents
live** (your hosts, not the laptop) and **how a human stays in charge of 20 of them** (attention, provenance,
evidence, undo). Both build on things only Sikemux has (the core daemon, native multi-vendor drivers, the
shared checkout, the phone/notch).

---

## 5. What to focus on, ranked

### 1. Sikemux Host — the shed
Run the core headless on Linux (and a spare Mac mini), install with one command, join it to the account.
The Mac app and the phone become clients of **several hosts**, each shown as a card with CPU/memory and
its agents. Agents keep working when the lid closes.
- Builds on: background core, iroh, join tickets, accounts backend, Linux packaging already in CI.
- Next step after it: move a project and its live agents between hosts (Teleport), and cross-host
  `agent_spawn` with lineage (T3's demo) once ADR 0012 lands.
- Also answers Owen's memory wall: the heavy stuff (dev servers, builds) runs on the box.
- Partner, don't operate, for cloud: "one-click Host on Hetzner / Fly Sprites" docs or scripts, never a
  compute-reselling fleet.

### 2. Many agents, one checkout, every line knows who wrote it
Nobody has this. Anthropic's article leaves it open.
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

### 3. The decision inbox (one surface for rail, notch and phone)
Replace notification streams with a ranked queue: blocked/asking agents first, changes to review next,
finished work, then progress. Batch on your schedule; show a work-in-progress count; write a handoff note
when an agent stops. A "while you were away" digest on open.
- Review by **intent + evidence**, not lines: what was asked, what the agent says it did, risk class
  (comment/test-only vs logic vs migration/protocol/server), checks that ran, and the browser recording or
  before/after screenshot it took (browser_record already exists). Diff last.
- Rules escalate the risky classes; routine changes with evidence pass. Approve / revert / steer from the
  phone in one tap.
- This is where Karpathy's "comprehension falls behind" becomes a product.

### 4. Finish agent-to-agent, then make review cross-vendor
- Ship ADR 0012 (spawn/send/read/wait, board, ask-the-lead).
- One button: "Claude builds, a GPT model attacks it" (or the reverse) with a rubric the builder never
  sees. Only a vendor-neutral app can offer this neutrally.
- **Definition-of-done gates:** checks an agent must pass before its card can move (tests, `pnpm check`
  slices, hooks that reject and say why). Huntley: enforcement beats rules files.
- After landing on main: run affected checks; if main goes red, bisect to the agent and commit and tell
  that agent. "Revert Otter's last commit" without touching anyone else.

### 5. Close the parity gaps that cost users, cheaply
- PR babysitter: an agent that watches its PR's CI and review comments, fixes, replies, re-requests
  review (code-host plumbing and the run watch loop already exist).
- Routines/schedules on your own host (Claude, Conductor, Superset, Antigravity all have them).
- Signals → board: Slack threads, Jira/Linear tickets, red CI become cards agents pick up (the Runlayer
  factory, built on plugins you already have).
- Finish #71 (install/sign-in in app) and #106 (survive Wi-Fi drops). Watch memory with 20 agents open.

### Stop or don't start
- Running your own cloud sandboxes or reselling compute/inference.
- A skills marketplace (90k+ low-quality skills on skills.sh; malware via ClawHub).
- A standalone AI review SaaS (CodeRabbit, Graphite/Cursor own it); keep review inside the app.
- Worktree wars and Best-of-N as the headline; keep worktrees as an option for the rare real conflict.
- Leading with the notch or the phone remote; every lab ships a remote now. Keep them as the delivery
  surface for the inbox.
- The GPUI rewrite (#115) stays parked; bounded memory matters more than the renderer right now.

---

## 6. Products to add

| Product | What | Price |
|---|---|---|
| **Sikemux** (Mac, Linux) | The whole local app, all vendors, unlimited agents, phone on one host, push | Free forever: it's the distribution and the labs give the equivalent away |
| **Sikemux Host** | Headless core for a Linux box / Mac mini / VPS; one-line install; one-click cloud recipes | Free for one host |
| **Sikemux Pro** | Multiple hosts per account, moving work between hosts, synced settings/skills/plugin config, history search across machines, routines on your hosts | ~$10/mo or $96/yr (Termius model: they make ~$4M on ~2M users charging for sync + devices) |
| **Sikemux Team** | Live shared sessions (join, steer, hand off, not just today's read-only share), shared skills/plugin setups, team inbox, central billing | ~$20/seat/mo — the most likely thing a company pays for |
| **Later: review check** | The same intent + evidence + adversarial review as a GitHub/Bitbucket check for teams | Team add-on |
| **Later: pin-to-agent widget** | A small script for staging/prod pages: click an element, leave a note, it lands as a card for your agents (Agentation-style, feeding the board) | Team add-on |

Optional later: require Pro/Team for commercial use above ~10 people (Docker Desktop / Fork model) once
there is real usage at companies.

---

## 7. Platform risk rules

- Never touch model credentials; launch vendors' own installers and logins (#71's stance is right).
- Keep the terminal transport fully working for every agent. If Anthropic revives metering of
  `claude -p` / stream-json for third-party apps, chat panes are what gets hit.
- Apply to OpenAI's "Sign in with ChatGPT" plan-usage programme for coding tools (live since 2026-09-29;
  Conductor, Warp, Amp, OpenCode, Hermes are in). It's permission and a listing.
- Support API keys and Bedrock/Vertex alongside subscriptions; show a cost meter per agent.
- Say "runs Claude Code"; never put Claude/Anthropic in names or marks.
- Treat OpenCode, Hermes, Pi, Grok, Muse as equals so no single policy change sinks the product.
- Security worth doing while keeping YOLO default: agent browser tabs on their own profile with no user
  cookies unless granted per site (agent browser + your sessions = the "lethal trifecta"), an audit log
  of agent-to-agent messages, per-turn snapshots.

---

## 8. Go-to-market

- X: short screen recordings showing the differentiators (two vendors' agents talking, the inbox on the
  phone, closing the lid while the shed keeps going).
- Show HN for the Host/Linux launch, not before.
- Comparison pages: vs Conductor, Orca, cmux, Claude Code desktop.
- Phone app in the App Store catches "Claude Code / Codex mobile" searches; word the listing carefully.
- Discord for retention.

## 9. Website implications

If the Host, the inbox, attribution or Team ship, sikemux.com needs new copy and a pricing page. The site
can already claim browser annotate-to-agent, which Herdr UI and Agentation market heavily.

## 10. Main sources

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
- [Herdr UI](https://herdrui.dev), [Agentation](https://www.agentation.com/), [T3 Code](https://t3.codes)
- [Mac coding agent apps comparison](https://rywalker.com/research/mac-coding-agent-apps),
  [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
  [Agent SDK plan usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Conductor pricing](https://www.conductor.build/pricing), [Superset pricing](https://superset.sh/pricing),
  [Termius pricing](https://termius.com/pricing), [vibe-kanban shutdown](https://vibekanban.com/blog/shutdown)
- [Agent Trace](https://agent-trace.dev/), [git-ai](https://usegitai.com/docs/get-started/how-git-ai-works),
  [GitButler parallel agents at Trigger.dev](https://trigger.dev/blog/parallel-agents-gitbutler)
