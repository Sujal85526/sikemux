import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS, mergePaths, slashTokenAt } from "./composerInput";

describe("mergePaths", () => {
    it("adds new paths after the ones already attached", () => {
        expect(mergePaths(["/a"], ["/b", "/c"])).toEqual(["/a", "/b", "/c"]);
    });

    it("skips duplicates, empty paths and paths with a null byte", () => {
        expect(mergePaths(["/a"], ["/a", "", "/b\0c", "/b", "/b"])).toEqual(["/a", "/b"]);
    });

    it("stops at the attachment limit", () => {
        const full = Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, index) => `/f${index}`);
        const merged = mergePaths(full, ["/x", "/y"]);
        expect(merged).toHaveLength(MAX_ATTACHMENTS);
        expect(merged.at(-1)).toBe("/x");
    });

    it("leaves the current list untouched", () => {
        const current = ["/a"];
        mergePaths(current, ["/b"]);
        expect(current).toEqual(["/a"]);
    });
});

describe("slashTokenAt", () => {
    it("finds a command at the start of the draft", () => {
        expect(slashTokenAt("/rev", 4)).toEqual({ start: 0, needle: "rev" });
        expect(slashTokenAt("/", 1)).toEqual({ start: 0, needle: "" });
    });

    it("finds a command part-way through a sentence", () => {
        expect(slashTokenAt("please /comp", 12)).toEqual({ start: 7, needle: "comp" });
    });

    it("reads only up to the caret", () => {
        expect(slashTokenAt("/review this", 4)).toEqual({ start: 0, needle: "rev" });
    });

    it("ignores a slash inside a word or path", () => {
        expect(slashTokenAt("src/main", 8)).toBeNull();
    });

    it("stops once the caret has moved past the command", () => {
        expect(slashTokenAt("/review this", 12)).toBeNull();
    });

    it("finds nothing at the start of the draft or without a slash", () => {
        expect(slashTokenAt("/review", 0)).toBeNull();
        expect(slashTokenAt("hello", 5)).toBeNull();
    });
});
