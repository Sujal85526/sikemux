import { describe, expect, it } from "vitest";
import { mayBeWaiting } from "./Approvals";
import { coarse } from "./hooks";

describe("mayBeWaiting", () => {
    it("asks GitHub only about a run it could actually be holding", () => {
        expect(mayBeWaiting("waiting", null)).toBe(true);
        expect(mayBeWaiting("action_required", null)).toBe(true);
        expect(mayBeWaiting("completed", "action_required")).toBe(true);
    });

    it("spends no request on a run nobody has to sign off", () => {
        expect(mayBeWaiting("completed", "success")).toBe(false);
        expect(mayBeWaiting("in_progress", null)).toBe(false);
        expect(mayBeWaiting("queued", null)).toBe(false);
    });
});

describe("coarse", () => {
    it("holds still within the minute, so a row reading 3h ago is not redrawn every second", () => {
        const base = Date.parse("2026-01-01T12:00:00Z");
        expect(coarse(base)).toBe(coarse(base + 59_000));
    });

    it("moves on once the minute does", () => {
        const base = Date.parse("2026-01-01T12:00:00Z");
        expect(coarse(base + 60_000)).toBeGreaterThan(coarse(base));
    });
});
