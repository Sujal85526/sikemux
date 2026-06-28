import { describe, expect, it } from "vitest";
import { normalisePinnedProjects, normaliseProjectRoots } from "./settingsLogic";

describe("settings command logic", () => {
    it("normalises project roots from legacy strings and objects", () => {
        expect(
            normaliseProjectRoots([
                "/repo/a",
                { path: "/repo/b", depth: 2.6 },
                { path: "/repo/c", depth: -3 },
                { path: "/repo/d", depth: Number.NaN },
                { nope: true },
                null,
            ]),
        ).toEqual([
            { path: "/repo/a", depth: 1 },
            { path: "/repo/b", depth: 3 },
            { path: "/repo/c", depth: 0 },
            { path: "/repo/d", depth: 1 },
        ]);
        expect(normaliseProjectRoots("bad")).toEqual([]);
    });

    it("normalises pinned projects from legacy strings and objects", () => {
        expect(normalisePinnedProjects(["/repo/a", { path: "/repo/b", extra: true }, { nope: true }, 42])).toEqual([
            { path: "/repo/a" },
            { path: "/repo/b" },
        ]);
        expect(normalisePinnedProjects(null)).toEqual([]);
    });
});
