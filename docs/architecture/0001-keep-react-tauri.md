# ADR 0001: Keep React and Tauri; do not rewrite Sikemux in GPUI

- Status: Accepted
- Decision date: 2026-08-10
- Revisit: only after the measured triggers below are met

## Context

The adjacent Zed checkout was inspected at commit
`4e8057d74db3570b3bd419ff296eb84c35b3a5a3` (2026-08-10). Its GPUI crate is
version 0.2.2, is licensed under Apache-2.0, and provides a native,
GPU-accelerated application framework. Zed demonstrates several patterns that
Sikemux should keep adopting independently of its UI toolkit: durable model
ownership outside renderers, bounded queues and caches, generation-fenced
asynchronous work, typed registries, lazy surfaces, frame-aligned rendering,
structured telemetry, and latency histograms.

A GPUI rewrite would replace the React/Tauri UI, CodeMirror, xterm.js, current
component tests, accessibility work, and IPC integration simultaneously. That
cost is justified only if the existing stack cannot meet an observed product
latency or resource target after its hot paths have been measured and fixed.

## Measurements

The decision used the production build and deterministic benchmarks from the
modernized codebase. Run them with:

```sh
pnpm build
pnpm perf:budget
pnpm bench:perf
```

The accepted 2026-08-10 baseline was:

| Measurement | Result | Enforced budget |
| --- | ---: | ---: |
| Startup JavaScript | 452,914 bytes raw / 141,142 gzip | 470,000 / 150,000 |
| All JavaScript | 2,341,770 bytes raw / 741,588 gzip | 2,350,000 / 750,000 |
| CodeMirror lazy chunk | 842,753 bytes raw / 297,548 gzip | 900,000 / 320,000 |
| xterm core lazy chunk | 385,767 bytes raw / 100,406 gzip | 430,000 / 115,000 |
| Application CSS | 204,453 bytes raw / 34,281 gzip | 220,000 / 37,000 |
| Rank 5,000 command candidates | 0.5633 ms mean / 1.0995 ms p99 | Measured regression baseline |
| Reconcile a 24-pane layout | 0.0011 ms mean / 0.0015 ms p99 | Measured regression baseline |
| Record 100 telemetry spans | 0.0723 ms mean / 0.2140 ms p99 | Measured regression baseline |

The runtime now also records startup, React commit, workbench reconciliation,
IPC, terminal output, and input/frame latency distributions. Native diagnostics
include bounded slow-operation records and a WebView heartbeat watchdog. These
measurements give future decisions real application evidence instead of using
framework reputation as a proxy.

## Decision

Keep the React 19 + Tauri 2 architecture. Continue using the adopted Zed/GPUI
patterns inside the current stack. Do not begin a whole-application GPUI rewrite
and do not add a second production UI implementation.

The project, item, action, task, transport, and backend seams are intentionally
toolkit-neutral enough to support a bounded GPUI prototype later without moving
process ownership or business state back into view components.

## Revisit triggers

Re-evaluate GPUI only when all of the following are true:

1. Production diagnostics show a repeatable user-visible problem, rather than a
   synthetic microbenchmark alone.
2. A representative interaction remains above 16.7 ms p95 or 33 ms p99, or the
   UI process has sustained memory/resource growth, after profiling and fixing
   the owning React/Tauri path.
3. A time-boxed GPUI spike implements the same representative flow, including
   PTY streaming, editor interaction, accessibility, persistence, and platform
   packaging.
4. The spike demonstrates a material improvement under identical workloads and
   includes migration cost, feature-parity risk, and maintenance ownership.

Crossing a JavaScript bundle budget by itself is not a rewrite trigger. It first
requires lazy-loading, dependency, and feature-scope work. Conversely, an
unfixable correctness or platform limitation may justify a new decision even if
the latency thresholds are not crossed.

## Consequences

- Sikemux keeps its mature CodeMirror and xterm.js integrations and current
  macOS/Windows packaging path.
- Performance budgets, runtime percentiles, bounded queues, and watchdog data
  remain release gates and the evidence for future architecture changes.
- New UI-heavy features should stay lazy because the aggregate JavaScript budget
  has less than one percent headroom at this baseline.
- GPUI remains a viable, Apache-2.0-licensed prototype option, not a committed
  migration or a runtime dependency.
