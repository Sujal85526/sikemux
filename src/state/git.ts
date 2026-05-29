// Git pane imperative helpers: open/close modals + record commands.
//
// Components call these from event handlers and never touch the store
// directly. `runGitCmd` is the wrapper every backend git call should
// flow through so the command log stays the single source of truth for
// "what did I just trigger".

import { emit } from "./bus";
import type {
  GitCheatsheetSection,
  GitMenuItem,
  GitPromptSuggestion,
} from "./gitTypes";
import { errMessage, reportError } from "./toast";
import { getState, setState } from "./store";

// ---- modal control ------------------------------------------------------

export function openGitMenu(title: string, items: GitMenuItem[]): void {
  setState({ gitModal: { kind: "menu", title, items } });
}

export function openGitConfirm(opts: {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}): void {
  setState({
    gitModal: {
      kind: "confirm",
      title: opts.title,
      body: opts.body,
      confirmLabel: opts.confirmLabel,
      cancelLabel: opts.cancelLabel,
      destructive: opts.destructive,
      onConfirm: opts.onConfirm,
    },
  });
}

export function openGitPrompt(opts: {
  title: string;
  placeholder?: string;
  initial?: string;
  multiline?: boolean;
  suggestions?: GitPromptSuggestion[];
  onConfirm: (value: string) => void | Promise<void>;
}): void {
  setState({
    gitModal: {
      kind: "prompt",
      title: opts.title,
      placeholder: opts.placeholder,
      initial: opts.initial,
      multiline: opts.multiline,
      suggestions: opts.suggestions,
      onConfirm: opts.onConfirm,
    },
  });
}

export function openGitCheatsheet(
  title: string,
  sections: GitCheatsheetSection[],
): void {
  setState({ gitModal: { kind: "cheatsheet", title, sections } });
}

export function closeGitModal(): void {
  setState({ gitModal: null });
}

// ---- command log -------------------------------------------------------

const LOG_LIMIT = 200;
let nextLogId = 1;

function pushLogEntry(label: string): number {
  const id = nextLogId++;
  setState((st) => {
    const entry = { id, ts: Date.now(), label, status: "running" as const };
    const next = [...st.gitCmdLog, entry];
    return {
      gitCmdLog: next.length > LOG_LIMIT ? next.slice(-LOG_LIMIT) : next,
    };
  });
  return id;
}

function patchLogEntry(
  id: number,
  patch: { status: "ok" | "error"; detail?: string },
): void {
  setState((st) => ({
    gitCmdLog: st.gitCmdLog.map((e) =>
      e.id === id ? { ...e, ...patch } : e,
    ),
  }));
}

export function toggleGitCmdLog(): void {
  setState((st) => ({ gitCmdLogOpen: !st.gitCmdLogOpen }));
}

export function clearGitCmdLog(): void {
  setState({ gitCmdLog: [] });
}

/** Wrap a backend git call with command-log bookkeeping. The returned
 *  promise resolves with whatever the inner function returned, or
 *  re-throws after logging the error — callers handle UX in the catch.
 *
 *  Truncates detail to ~4 KB so a chatty `git log` output doesn't grow
 *  the store transcript unboundedly.
 *
 *  Pass `repo` so a successful op emits the `git-refresh` bus event —
 *  consumers like `useGitBaseline` listen for that to refetch HEAD
 *  content. Skipping it (or passing null) is fine for read-only calls
 *  that can't move HEAD or rewrite the index. */
export async function runGitCmd<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { showError?: boolean; repo?: string | null },
): Promise<T> {
  const id = pushLogEntry(label);
  try {
    const out = await fn();
    const detail =
      typeof out === "string"
        ? out.length > 4096
          ? out.slice(0, 4096) + "…"
          : out
        : undefined;
    patchLogEntry(id, { status: "ok", detail });
    if (opts?.repo) emit({ type: "git-refresh", repo: opts.repo });
    return out;
  } catch (e) {
    const msg = errMessage(e);
    patchLogEntry(id, {
      status: "error",
      detail: msg.length > 4096 ? msg.slice(0, 4096) + "…" : msg,
    });
    if (opts?.showError !== false) reportError(label)(e);
    throw e;
  }
}

/** Synchronously dispatch the currently-focused modal item by hot key.
 *  Returns true if the key was claimed (renderer should preventDefault). */
export function dispatchGitMenuKey(k: string): boolean {
  const m = getState().gitModal;
  if (!m || m.kind !== "menu") return false;
  const item = m.items.find((i) => i.key === k);
  if (!item || item.disabled) return false;
  closeGitModal();
  void item.run();
  return true;
}
