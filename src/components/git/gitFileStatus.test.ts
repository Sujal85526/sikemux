import { describe, expect, it } from "vitest";
import { gitFileDecoration, gitStatusDecoration } from "./gitFileStatus";

describe("git file status decorations", () => {
    it.each([
        ["?", "U", "u"],
        ["U", "U", "u"],
        ["A", "A", "a"],
        ["D", "D", "d"],
        ["R", "R", "r"],
        ["C", "C", "r"],
        ["T", "T", "m"],
        ["M", "M", "m"],
    ])("maps %s to the existing %s decoration", (raw, letter, cls) => {
        expect(gitStatusDecoration(raw)).toMatchObject({ letter, cls });
    });

    it("keeps the file-tree conflict and deletion priority", () => {
        expect(gitFileDecoration({ path: "file.ts", index: "A", worktree: "D" })).toMatchObject({ letter: "D", cls: "d" });
        expect(gitFileDecoration({ path: "file.ts", index: "M", worktree: "?" })).toMatchObject({ letter: "U", cls: "u" });
    });
});
