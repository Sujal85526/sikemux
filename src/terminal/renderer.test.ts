import { describe, expect, it } from "vitest";
import { terminalWebglRequested } from "./renderer";

describe("terminalWebglRequested", () => {
    it.each([true, "1", "true", " TRUE "])("enables WebGL for %j", (value) => {
        expect(terminalWebglRequested(value)).toBe(true);
    });

    it.each([undefined, null, false, 0, "0", "false", "on", ""])("keeps the DOM renderer for %j", (value) => {
        expect(terminalWebglRequested(value)).toBe(false);
    });
});
