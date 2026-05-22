import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceSnapshot } from "./types";
import { useWorkspace } from "./workspace";

// Bumped on model changes — older state files are ignored, falling back to
// defaults. 3: agents gained a `startup` command.
const VERSION = 3;
let lastSaved = "";

function snapshot(): string {
  const s = useWorkspace.getState();
  const snap: WorkspaceSnapshot = {
    version: VERSION,
    sessions: s.sessions,
    activeSessionId: s.activeSessionId,
    recent: s.recent,
    agentBookmarks: s.agentBookmarks,
    leftRailOpen: s.leftRailOpen,
    rightRailOpen: s.rightRailOpen,
  };
  return JSON.stringify(snap);
}

// Load persisted workspace state and hydrate the store. Safe on a missing or
// corrupt file — falls back to defaults.
export async function hydrateFromDisk(): Promise<void> {
  try {
    const raw = await invoke<string>("state_load");
    if (!raw) return;
    const data = JSON.parse(raw) as WorkspaceSnapshot;
    if (
      data?.version === VERSION &&
      Array.isArray(data.sessions) &&
      data.sessions.length > 0
    ) {
      useWorkspace.getState().hydrate(data);
      lastSaved = snapshot();
    }
  } catch {
    /* corrupt state — ignore, keep defaults */
  }
}

// Debounced save on every store change. Returns an unsubscribe function.
export function subscribePersist(): () => void {
  let timer: number | undefined;
  return useWorkspace.subscribe(() => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const snap = snapshot();
      if (snap === lastSaved) return; // only persistable fields changed-check
      lastSaved = snap;
      void invoke("state_save", { data: snap });
    }, 600);
  });
}
