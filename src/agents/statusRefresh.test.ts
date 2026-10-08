import { describe, expect, it, vi } from "vitest";
import { noteSignedOut, REFRESH_AT_MOST_EVERY_MS, statusRefresher } from "./statusRefresh";

describe("statusRefresher", () => {
    it("forgets every status and reloads the agent lists, at most once per interval", async () => {
        let now = 1_000;
        const refresh = vi.fn().mockResolvedValue(undefined);
        const invalidate = vi.fn();
        const refreshStatuses = statusRefresher({ refresh, invalidate, now: () => now });

        await refreshStatuses();
        expect(refresh).toHaveBeenCalledTimes(1);
        const matches = invalidate.mock.calls[0][0] as (kind: string) => boolean;
        expect(matches("agents.catalog")).toBe(true);
        expect(matches("agents.account")).toBe(true);
        expect(matches("agents.models")).toBe(false);

        now += REFRESH_AT_MOST_EVERY_MS - 1;
        await refreshStatuses();
        expect(refresh).toHaveBeenCalledTimes(1);

        now += 1;
        await refreshStatuses();
        expect(refresh).toHaveBeenCalledTimes(2);
    });
});

describe("noteSignedOut", () => {
    it("marks the chat's account signed out and reloads the agent lists", async () => {
        const mark = vi.fn().mockResolvedValue(undefined);
        const invalidate = vi.fn();
        await noteSignedOut("codex", "/Users/me/.codex-work", { mark, invalidate });
        expect(mark).toHaveBeenCalledWith("codex", "/Users/me/.codex-work");
        expect((invalidate.mock.calls[0][0] as (kind: string) => boolean)("agents.catalog")).toBe(true);
    });
});
