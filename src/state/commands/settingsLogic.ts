import type { PinnedProject, ProjectRoot } from "../types";

export function normaliseProjectRoots(raw: unknown): ProjectRoot[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((r): ProjectRoot | null => {
            if (typeof r === "string") return { path: r, depth: 1 };
            if (r && typeof r === "object" && typeof (r as ProjectRoot).path === "string") {
                const depth = (r as ProjectRoot).depth;
                return {
                    path: (r as ProjectRoot).path,
                    depth: Number.isFinite(depth) ? Math.max(0, Math.round(depth)) : 1,
                };
            }
            return null;
        })
        .filter((x): x is ProjectRoot => x !== null);
}

export function normalisePinnedProjects(raw: unknown): PinnedProject[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((p): PinnedProject | null => {
            if (typeof p === "string") return { path: p };
            if (p && typeof p === "object" && typeof (p as PinnedProject).path === "string") {
                return { path: (p as PinnedProject).path };
            }
            return null;
        })
        .filter((x): x is PinnedProject => x !== null);
}
