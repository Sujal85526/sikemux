import { describe, expect, it } from "vitest";
import { AI_MODELS, defaultAiModel } from "./gitPaneConstants";
import { filterByQuery, helpRows, isGitAiProvider, isInRange, rangeBadge } from "./gitPaneLogic";

describe("GitPane extracted logic", () => {
    it("validates configured local AI providers and default models", () => {
        expect(isGitAiProvider("hermes")).toBe(true);
        expect(isGitAiProvider("codex")).toBe(true);
        expect(isGitAiProvider("claude")).toBe(true);
        expect(isGitAiProvider("nope")).toBe(false);
        expect(defaultAiModel("hermes")).toBe(AI_MODELS.hermes[0]);
    });

    it("formats range state", () => {
        expect(rangeBadge(null)).toBeNull();
        expect(rangeBadge([2, 5])).toBe("range 4");
        expect(isInRange([2, 5], 1)).toBe(false);
        expect(isInRange([2, 5], 2)).toBe(true);
        expect(isInRange([2, 5], 5)).toBe(true);
        expect(isInRange(null, 3)).toBe(false);
    });

    it("builds cheatsheet rows", () => {
        expect(helpRows(["x", "do x"], ["y", "do y"])).toEqual([
            { keys: "x", label: "do x" },
            { keys: "y", label: "do y" },
        ]);
    });

    it("filters rows across multiple fields case-insensitively", () => {
        const rows = [
            { path: "src/components/GitPane.tsx", status: "modified" },
            { path: "README.md", status: "clean" },
            { path: "src/bruno/run.ts", status: "staged" },
        ];

        expect(filterByQuery(rows, "git", (r) => [r.path, r.status])).toEqual([rows[0]]);
        expect(filterByQuery(rows, "STAGED", (r) => [r.path, r.status])).toEqual([rows[2]]);
        expect(filterByQuery(rows, "", (r) => [r.path])).toEqual(rows);
    });
});
