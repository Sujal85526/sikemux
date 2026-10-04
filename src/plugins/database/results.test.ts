import { describe, expect, it } from "vitest";
import type { ResultSet } from "./api";
import { cellText, duration, mainResult, summary, toMarkdown, toTsv } from "./results";

const customers: ResultSet = {
    columns: [
        { name: "id", type: "int4", numeric: true },
        { name: "name", type: "text", numeric: false },
        { name: "note", type: "text", numeric: false },
    ],
    rows: [
        [1, "Ada", "likes | pipes"],
        [2, "Linus", null],
    ],
    truncated: false,
    affected: null,
};

const changed: ResultSet = { columns: [], rows: [], truncated: false, affected: 3 };

describe("results", () => {
    it("shows each kind of cell", () => {
        expect(cellText(null)).toBe("NULL");
        expect(cellText(true)).toBe("true");
        expect(cellText(42.5)).toBe("42.5");
        expect(cellText("9223372036854775807")).toBe("9223372036854775807");
    });

    it("sums up rows returned, rows changed and rows left out", () => {
        expect(summary(customers)).toBe("2 rows");
        expect(summary(changed)).toBe("3 rows changed");
        expect(summary({ ...changed, affected: 1 })).toBe("1 row changed");
        expect(summary({ ...customers, truncated: true })).toBe("First 2 rows; more were left out");
    });

    it("writes durations the way people read them", () => {
        expect(duration(12)).toBe("12 ms");
        expect(duration(1530)).toBe("1.53 s");
        expect(duration(42_000)).toBe("42.0 s");
        expect(duration(125_000)).toBe("2 min 5 s");
    });

    it("shows the last result that returned rows", () => {
        expect(mainResult({ results: [customers, changed], millis: 1 })).toBe(0);
        expect(mainResult({ results: [changed, customers], millis: 1 })).toBe(1);
        expect(mainResult({ results: [changed, changed], millis: 1 })).toBe(1);
        expect(mainResult({ results: [], millis: 1 })).toBe(0);
    });

    it("copies as tab-separated text with empty cells for null", () => {
        expect(toTsv(customers)).toBe("id\tname\tnote\n1\tAda\tlikes | pipes\n2\tLinus\t");
    });

    it("writes a markdown table for an agent, numbers to the right and pipes escaped", () => {
        expect(toMarkdown(customers)).toBe(
            ["| id | name | note |", "| ---: | --- | --- |", "| 1 | Ada | likes \\| pipes |", "| 2 | Linus | NULL |"].join("\n"),
        );
        expect(toMarkdown(customers, 1)).toContain("2 rows; 1 more row not shown");
        expect(toMarkdown(changed)).toBe("3 rows changed");
    });
});
