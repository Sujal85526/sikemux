import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { PinnedProject, ProjectRoot } from "../state/types";

export interface ProjectEntry {
    name: string;
    path: string;
}

export const settingsApi = {
    scanProjectRoots: (pinnedProjects: PinnedProject[], roots: ProjectRoot[]) =>
        invoke<ProjectEntry[]>("scan_project_roots", { pinnedProjects, roots }),
    expandPath: (path: string) => invoke<string>("expand_path", { path }),
    isDirectory: (path: string) => invoke<boolean>("is_directory", { path }),
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
