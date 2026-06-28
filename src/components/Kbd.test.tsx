import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ALT, CMD, CTRL, Kbd, SHIFT, hint } from "./Kbd";

describe("Kbd", () => {
    it("renders visible keyboard chips and hint strings", () => {
        render(<Kbd>{ALT}S</Kbd>);
        expect(screen.getByText("⌥S")).toHaveClass("kbd");
        expect(hint(CMD, SHIFT, CTRL, "P")).toBe("⌘⇧⌃P");
    });
});
