import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ProjectRoot } from "../state/types";

export interface ProjectEntry {
    name: string;
    path: string;
}

export const settingsApi = {
    scanProjectRoots: (roots: ProjectRoot[]) => invoke<ProjectEntry[]>("scan_project_roots", { roots }),
    expandPath: (path: string) => invoke<string>("expand_path", { path }),
    pickFolder: async (defaultPath?: string): Promise<string | null> => {
        const picked = await open({
            directory: true,
            multiple: false,
            defaultPath,
        });
        if (picked == null) return null;
        return Array.isArray(picked) ? (picked[0] ?? null) : picked;
    },
};
