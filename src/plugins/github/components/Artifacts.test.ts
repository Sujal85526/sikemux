import { describe, expect, it } from "vitest";
import { annotationPlace } from "./Annotations";
import { formatBytes } from "./Artifacts";

describe("formatBytes", () => {
    it("writes a size the way a download shelf does", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(2048)).toBe("2.0 KB");
        expect(formatBytes(15_360)).toBe("15 KB");
        expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
        expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
    });

    it("stops at gigabytes rather than inventing a unit", () => {
        expect(formatBytes(5 * 1024 ** 4)).toBe("5120 GB");
    });
});

describe("annotationPlace", () => {
    it("writes the file and line the way an editor jumps to them", () => {
        expect(annotationPlace("src/lib.rs", 12)).toBe("src/lib.rs:12");
    });

    it("leaves the line off when there is not one", () => {
        expect(annotationPlace("src/lib.rs", null)).toBe("src/lib.rs");
    });

    it("says nothing for a failure that belongs to no file", () => {
        expect(annotationPlace(null, 12)).toBeNull();
        expect(annotationPlace(null, null)).toBeNull();
    });
});
