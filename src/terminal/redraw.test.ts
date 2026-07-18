import { describe, expect, it } from "vitest";
import { needsTerminalRedraw } from "./redraw";

const encode = (text: string) => new TextEncoder().encode(text);

describe("needsTerminalRedraw", () => {
    it("requests a redraw for zsh's erase-line sequences", () => {
        expect(needsTerminalRedraw(encode("\r\u001b[0K"))).toBe(true);
        expect(needsTerminalRedraw(encode("\u001b[K"))).toBe(true);
        expect(needsTerminalRedraw(encode("\u001b[2J"))).toBe(true);
    });

    it("does not repaint for ordinary terminal output", () => {
        expect(needsTerminalRedraw(encode("hello\r\n\u001b[32mok\u001b[0m"))).toBe(false);
    });
});
