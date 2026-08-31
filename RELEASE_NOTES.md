# Sikemux v0.3.3

Sikemux 0.3.3 brings browser automation into agent panes, turns Git review into a complete multi-file workspace, and makes long-running coding sessions lighter and easier to navigate.

## Browser automation

- Give every coding agent an embedded browser it can drive through MCP while you watch and interact with the same page in Sikemux. The browser runtime and Browser Use sidecar ship with the app, so no separate Chromium or Python setup is required.
- Keep browser tabs isolated by agent. Tab ownership and the active tab are recorded transactionally, browser targets close with their agent or session, and a per-launch authenticated broker creates the debugging connection only when an agent first needs it.
- Make direct interaction dependable: pointer drags retain capture until release, interrupted drags cannot leave Chromium holding the mouse button, blank tabs follow the active theme, and the old virtual cursor is gone.
- Verify the frozen sidecar against the bundled Chromium during builds, fingerprint runtime inputs so stale browser bundles are replaced, and audit the Python dependency set locally and in CI.

## Git review

- Review every changed file in one continuous Diffs-powered workspace instead of opening files one at a time. Large reviews window their rendered content so navigating a broad change set stays responsive.
- Use compact status glyphs throughout the review surface for faster scanning.

## Agents

- Put idle agent sessions to sleep without losing their terminal state, reducing the cost of keeping a workspace open for a long time.
- Resolve only healthy installed CLI profiles, scope the agent picker to the current workspace, and keep the picker available in projects that do not yet have an agent.

## Rundeck

- Follow running executions live. Status, step progress, and output stay synchronized through completion instead of presenting a stale launch snapshot.

## Terminal and workspace

- Build terminal environments once from the user's login profile, preserve its `EDITOR` choice, and fence the captured environment so startup output cannot corrupt it or restore an inherited agent identity.
- Reorder projects by dragging them in the rail, with stable hit testing and clearer drop movement.
- Tighten the title bar, project rail, pane edges, focus chrome, and session-close controls into a flatter full-bleed shell.

The published automatic-update feed continues to target Apple Silicon macOS.

For the complete patch history, compare [`v0.3.2...v0.3.3`](https://github.com/nodelike/sikemux/compare/v0.3.2...v0.3.3).
