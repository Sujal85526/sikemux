import { describe, expect, it } from "vitest";
import { terminalWebglRequested } from "./renderer";

describe("terminalWebglRequested", () => {
    it.each([undefined, null, true, "1", "true", " TRUE ", "on", ""])("uses WebGL for %j", (value) => {
        expect(terminalWebglRequested(value)).toBe(true);
    });

    it.each([false, "0", "false", " FALSE "])("falls back to the DOM renderer for %j", (value) => {
        expect(terminalWebglRequested(value)).toBe(false);
    });
});
