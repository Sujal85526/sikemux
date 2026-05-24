import { invoke } from "@tauri-apps/api/core";

// Cached per-cwd file list. The backend invalidates its own cache on fs
// events; we additionally cache here so reopening the palette while files
// haven't changed shows results instantly (no IPC round-trip).
const inflight = new Map<string, Promise<string[]>>();
const cache = new Map<string, string[]>();

export const filesApi = {
  list: (repo: string): Promise<string[]> => {
    const hit = cache.get(repo);
    if (hit) return Promise.resolve(hit);
    const existing = inflight.get(repo);
    if (existing) return existing;
    const p = invoke<string[]>("list_project_files", { repo })
      .then((list) => {
        cache.set(repo, list);
        return list;
      })
      .finally(() => inflight.delete(repo));
    inflight.set(repo, p);
    return p;
  },
  /** Drop the frontend cache for one repo (or all). Call when fs events fire. */
  invalidate: (repo?: string) => {
    if (repo) cache.delete(repo);
    else cache.clear();
  },
};
