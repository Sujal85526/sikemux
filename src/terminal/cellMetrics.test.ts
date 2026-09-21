import { describe, expect, it } from "vitest";
import { cellWidthCorrection } from "./cellMetrics";

describe("cellWidthCorrection", () => {
    it("widens the cell back when JetBrains Mono lands between pixels", () => {
        // 13px at 0.6em is 7.8 css pixels, which WebGL would floor to 15 of 15.6.
        expect(cellWidthCorrection(7.8, 2)).toBe(1);
        expect(cellWidthCorrection(7.8, 1)).toBe(1);
    });

    it("leaves a cell that already lands on a pixel alone", () => {
        expect(cellWidthCorrection(9, 2)).toBe(0);
        expect(cellWidthCorrection(7.5, 2)).toBe(0);
    });

    it("keeps the cell at the nearer pixel rather than always widening", () => {
        expect(cellWidthCorrection(7.7, 3)).toBe(0); // 23.1 is already close enough to 23
        expect(cellWidthCorrection(7.6, 3)).toBe(1); // 22.8 belongs at 23, not 22
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("makes no correction for a char width of %j", (width) => {
        expect(cellWidthCorrection(width, 2)).toBe(0);
    });

    it.each([0, -2, Number.NaN])("makes no correction for a pixel ratio of %j", (ratio) => {
        expect(cellWidthCorrection(7.8, ratio)).toBe(0);
    });
});
