import { describe, expect, it } from "vitest";
import { processGlyph } from "./processGlyph";

describe("processGlyph", () => {
    it("knows a runtime by its process name, a path or a version suffix", () => {
        expect(processGlyph("node")?.char).toBe("");
        expect(processGlyph("next-server (v14.2.3)")?.char).toBe("");
        expect(processGlyph("/usr/local/bin/python3.12")).toEqual(processGlyph("python"));
        expect(processGlyph("uvicorn")).toEqual(processGlyph("python"));
    });

    it("has none for a process that names no runtime", () => {
        expect(processGlyph("ai-service")).toBeNull();
        expect(processGlyph("")).toBeNull();
    });
});
