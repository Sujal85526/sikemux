---
name: sikemux-harness
description: How to drive a Sikemux project and its browser — task launches, output and event cursors, opening UI, and the tab model.
---

# Working inside Sikemux

You are running in a pane of a Sikemux workspace. The tools named `sikemux_*`
act on the project the person has open. The tools named `browser_*` act on the
browser tabs in your own pane, which the person can see.

Read this once before your first task launch or browser click. Everything the
tool descriptions leave out is here.

## Start by inspecting

`sikemux_workspace_inspect` is the entry point. It returns the open project,
its panes, the tasks configured in `sikemux.json`, the harness runs you already
started, and an event cursor. Task ids come from there — do not guess one.

## Running a task

`sikemux_task_start` takes a `taskId` and an `idempotencyKey` you choose.

The key is what makes a retry safe. Reusing a key returns the original
execution rather than starting a second one, and it keeps doing so after that
execution has finished. Pick one key per logical attempt and reuse it when a
call fails or you are unsure whether it landed.

Two things can stop a launch:

- The project may need trust. Sikemux shows its own dialog, and a changed
  `sikemux.json` is checked again before the next launch.
- If the same task is already running from the command deck, stop it there
  first. Starting a task already running through the harness just returns that
  execution.

Task terminals open in the background. To show one to the person, call
`sikemux_ui_open` with `kind: "terminal"`, the `executionId`, and `focus: true`.

## Reading output

`sikemux_task_read` pages through a task's output by byte cursor.

Start at cursor `0`. Pass the returned `cursor` into the next call. Keep
reading while `hasMore` is true. Pages are 8 KiB by default; `limit` accepts
4 to 8192 bytes.

Two things to expect in the bytes:

- Output is raw terminal data and may contain escape sequences.
- A task retains about 1 MiB. If your cursor is older than the retained bytes,
  `truncated` comes back true — you have lost the gap and should read on from
  the cursor you were given rather than trying to recover it.

Finished terminals are kept for roughly ten minutes, and can be dropped sooner
when the app is under pressure. Read output you care about promptly.

## Waiting for something to happen

`sikemux_events_wait` blocks for up to 30 seconds and returns task output,
task lifecycle, and UI-open events.

**Event cursors are not output cursors.** They are separate sequences. Get an
event cursor from `sikemux_workspace_inspect`, pass it to `events_wait`, and
pass each returned cursor into the next wait. Passing an output cursor here is
a mistake.

A timeout is normal: you get an empty event list and a fresh cursor. Wait
again. Pass an `executionId` to hear only about one task.

Event history holds 256 entries. If a wait comes back `truncated`, stop
replaying and inspect the workspace again for current state.

A wait does not schedule you a future turn. It only holds this call open.

## Opening things for the person

`sikemux_ui_open` takes a `kind`:

- `file` — with a `path` inside the project and an optional one-based `line`
- `diff` — with a `path`
- `terminal` — with an `executionId`
- `preview` — the project's configured preview

Files open as background tabs. Add `focus: true` to actually reveal one.

Paths must resolve inside the project; a path that escapes it is refused.

Preview needs an agent session and opens in your own browser. The `previewUrl`
you get back is configuration, not proof that anything is listening. If you
need to know the server is up, read the task output or navigate to it.

## Stopping

`sikemux_task_stop` takes an `executionId` and stops that exact execution and
its process tree. It does not stop a task started from the command deck.

## The browser

`browser_state` returns page state: url, title, numbered interactive elements,
visible text, and the open tabs. Most browser tools return the same shape after
acting, so you rarely need a separate read.

**Element numbers expire.** They are only valid until the next state read. Read
state, act on a number from that read, and treat the numbers in the result as
the new set. Never reuse a number across two reads.

`browser_click` takes a number from the latest state. `browser_back` and
`browser_forward` move through the current tab's history.

`browser_type` replaces an element's value rather than appending. With `index`
omitted it types into whatever is focused. `submit: true` presses Enter
afterwards.

`browser_press` sends one key to the focused element — `Enter`, `Tab`,
`Escape`, `ArrowDown`, or a single character.

`browser_scroll` moves the page by `deltaY` pixels, default 600, negative for
up. Pass an `index` to scroll inside a scrollable element instead.

`browser_wait` sleeps for `ms` (default 1000, max 30000) and then waits for any
load to finish. Prefer it over repeated state reads when a page is settling.

`browser_screenshot` returns an image of the visible part of the tab. Use it
when layout or rendering matters; use `browser_extract` when you only need
text.

`browser_network` lists the fetch and XHR calls the page has made since it
loaded, oldest first, with each status, duration and a truncated response body.
It is how you tell a request that failed apart from a button that never asked,
which the DOM alone cannot show. Narrow a busy page with `filter`, a substring
of the URL. Only fetch and XHR appear; images, scripts and the document itself
do not.

Tabs are yours. `browser_list_tabs`, `browser_switch_tab` and
`browser_close_tab` act on this pane's tabs, not the person's other windows.
`browser_navigate` reuses the current tab unless you pass `newTab: true`.

## What does not survive

Run history and idempotency keys live for the current frontend session, capped
at 128 runs and 256 keys. Restarting the app does not resume commands, and
reloading the frontend loses run handles. Closing the project stops its harness
tasks.

If you hit a capacity error on either cap, the person needs to restart Sikemux;
you cannot clear it yourself.

## The same operations from a shell

Every tool here is also a CLI verb, which is useful inside a task or a script:

```bash
sikemux tool workspace.inspect
sikemux tool task.start '{"taskId":"dev","idempotencyKey":"dev-first-run"}'
sikemux tool task.read '{"executionId":"ID","cursor":0}'
sikemux tool events.wait '{"cursor":"CURSOR","timeoutMs":30000}'
sikemux tool ui.open '{"kind":"file","path":"src/App.tsx","line":42,"focus":true}'
sikemux tool task.stop '{"executionId":"ID"}'
```

Terminals that Sikemux launches already carry the project and agent context.
From any other shell, run the CLI inside the open project's Git root or set
`SIKEMUX_PROJECT`.
