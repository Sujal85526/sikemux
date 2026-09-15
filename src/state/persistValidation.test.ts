import { describe, expect, it } from "vitest";
import { validatePersistedLayout } from "./persistValidation";

const pane = (id: string) => ({ type: "pane", id, cwd: "", kind: "terminal", title: id });

describe("validatePersistedLayout", () => {
    it("accepts every split direction the layout can produce", () => {
        for (const dir of ["row", "column", "stack"]) {
            const result = validatePersistedLayout({ type: "split", id: `s-${dir}`, dir, children: [pane("a"), pane("b")], sizes: [0.5, 0.5] });
            expect(result.ok, dir).toBe(true);
        }
    });

    it("rejects a direction the layout cannot produce", () => {
        const result = validatePersistedLayout({ type: "split", id: "s", dir: "grid", children: [pane("a"), pane("b")], sizes: [0.5, 0.5] });
        expect(result).toEqual({ ok: false, reason: "split direction is invalid" });
    });
});
