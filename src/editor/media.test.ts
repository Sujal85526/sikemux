import { describe, expect, it } from "vitest";
import { extname, isImagePath } from "./media";

describe("editor media helpers", () => {
    it("extracts lowercase extensions", () => {
        expect(extname("/tmp/photo.PNG")).toBe("png");
        expect(extname("/tmp/archive.tar.gz")).toBe("gz");
        expect(extname(".gitignore")).toBe("");
        expect(extname("noext")).toBe("");
    });

    it("detects supported image paths", () => {
        expect(isImagePath("diagram.svg")).toBe(true);
        expect(isImagePath("photo.jpeg")).toBe(true);
        expect(isImagePath("README.md")).toBe(false);
        expect(isImagePath(null)).toBe(false);
    });
});
