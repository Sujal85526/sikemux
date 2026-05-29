// Git pane infrastructure types. Lives outside types.ts because the git
// pane has a lot of internal vocabulary (modals, command log, panel
// state) that doesn't belong in the shared core. types.ts re-exports
// what's reachable across modules.

/** A menu item — single hot-key letter, label, optional hint shown on
 *  the right, and the imperative action to run on select. `destructive`
 *  tints the row red so users notice operations that lose data. */
export interface GitMenuItem {
  key?: string;
  label: string;
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

/** Suggestion entry shown under the prompt when free-text input has a
 *  bounded set of valid completions (branch names, refs, …). */
export interface GitPromptSuggestion {
  value: string;
  hint?: string;
}

/** Discriminated union of every modal the git pane can show. Stored in
 *  `store.gitModal`; one renderer mounted at GitPane root reads it and
 *  paints. Open + close are imperative (`openGitMenu(...)`) but the
 *  state lives in the store so React just re-renders. */
export type GitModal =
  | {
      ownerPaneId: string | null;
      kind: "menu";
      title: string;
      items: GitMenuItem[];
    }
  | {
      ownerPaneId: string | null;
      kind: "confirm";
      title: string;
      body: string;
      confirmLabel?: string;
      cancelLabel?: string;
      destructive?: boolean;
      onConfirm: () => void | Promise<void>;
    }
  | {
      ownerPaneId: string | null;
      kind: "prompt";
      title: string;
      placeholder?: string;
      initial?: string;
      multiline?: boolean;
      suggestions?: GitPromptSuggestion[];
      onConfirm: (value: string) => void | Promise<void>;
    }
  | {
      ownerPaneId: string | null;
      kind: "cheatsheet";
      title: string;
      sections: GitCheatsheetSection[];
    };

/** Help cheatsheet bound to `?`. Each section is one panel's keybinds. */
export interface GitCheatsheetSection {
  title: string;
  rows: { keys: string; label: string }[];
}

/** One entry in the command log. We push a row in `running` state before
 *  invoking the backend command and patch the same row when the result
 *  comes back, so the user sees the in-flight indicator without flicker.
 *
 *  Capped at LOG_LIMIT (200) — older entries fall off the front. */
export interface GitCmdEntry {
  id: number;
  ts: number;
  label: string;
  status: "running" | "ok" | "error";
  /** Free-form output / error text for the expanded view. Truncated to
   *  ~4 KB so a chatty `git log` doesn't bloat the store. */
  detail?: string;
}
