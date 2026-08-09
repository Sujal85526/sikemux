import { describe, expect, it } from "vitest";
import { worktreeHasLiveOwners } from "./worktreeLifecycle";

describe("worktree lifecycle", () => {
    it("protects project sessions and agent-owned worktrees", () => {
        const project = {
            id: "project",
            name: "lane",
            kind: "project" as const,
            cwd: "/work/lane",
            pinned: false,
            activeWindowId: "window",
            activeAgentId: null,
            view: "windows" as const,
        };
        expect(worktreeHasLiveOwners({ sessions: { project }, agents: {} }, "/work/lane")).toBe(true);
        expect(
            worktreeHasLiveOwners(
                {
                    sessions: {},
                    agents: { agent: { id: "agent", type: "codex", title: "agent", startup: "codex", cwd: "/work/lane" } },
                },
                "/work/lane",
            ),
        ).toBe(true);
        expect(worktreeHasLiveOwners({ sessions: {}, agents: {} }, "/work/lane")).toBe(false);
    });
});
