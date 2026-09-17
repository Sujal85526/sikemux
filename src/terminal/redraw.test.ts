import { describe, expect, it } from "vitest";
import { needsTerminalRedraw } from "./redraw";

const encode = (text: string) => new TextEncoder().encode(text);

describe("needsTerminalRedraw", () => {
    it("requests a redraw for zsh's erase-to-end-of-line", () => {
        expect(needsTerminalRedraw(encode("\r[0K"))).toBe(true);
        expect(needsTerminalRedraw(encode("[Khello"))).toBe(true);
    });

    it("leaves the other erase sequences alone", () => {
        expect(needsTerminalRedraw(encode("[2J"))).toBe(false);
        expect(needsTerminalRedraw(encode("[1K"))).toBe(false);
        expect(needsTerminalRedraw(encode("[2Kx"))).toBe(false);
    });

    it("does not repaint for ordinary terminal output", () => {
        expect(needsTerminalRedraw(encode("hello\r\n[32mok[0m"))).toBe(false);
    });
});
