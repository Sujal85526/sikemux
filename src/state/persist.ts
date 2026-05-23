import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceSnapshot } from "./types";
import { useWorkspace } from "./workspace";

// `applyHydrate` is the canonical entry point — called from App.tsx with the
// raw JSON returned by `boot_init`. The on-disk read happens server-side now,
// so there's no standalone `hydrateFromDisk` anymore.


// Bumped on model changes — older state files are ignored, falling back to
// defaults. 3: agents gained a `startup` command.
const VERSION = 3;
let lastSaved = "";

function snapshot(): string {
  const s = useWorkspace.getState();
  const snap: WorkspaceSnapshot = {
    version: VERSION,
    sessions: s.sessionOrder.map((id) => s.sessions[id]),
    activeSessionId: s.activeSessionId,
    recent: s.recent,
    agentBookmarks: s.agentBookmarks,
    leftRailOpen: s.leftRailOpen,
    rightRailOpen: s.rightRailOpen,
  };
  return JSON.stringify(snap);
}

/** Hydrate from a raw JSON string (e.g. the one returned by `boot_init`). */
export function applyHydrate(raw: string): void {
  if (!raw) return;
  try {
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
      if (snap === lastSaved) return;
      lastSaved = snap;
      void invoke("state_save", { data: snap });
    }, 600);
  });
}
