export interface GitMenuItem {
    key?: string;
    label: string;
    hint?: string;
    destructive?: boolean;
    disabled?: boolean;
    run: () => void | Promise<void>;
}

export interface GitPromptSuggestion {
    value: string;
    hint?: string;
}

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

export interface GitCheatsheetSection {
    title: string;
    rows: { keys: string; label: string }[];
}

export interface GitCmdEntry {
    id: number;
    ts: number;
    label: string;
    status: "running" | "ok" | "error";
    detail?: string;
}
