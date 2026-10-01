import { describe, expect, it } from "vitest";
import type { CoreSession } from "../api/coreSessions";
import { agentSessionPlan, claimedSessionIds, unclaimedTerminals } from "./coreSessionClaims";
import { cloneLayout } from "./layout";
import type { Agent, PaneNode, Window } from "./types";

function session(id: number, overrides: Partial<CoreSession> = {}): CoreSession {
    return {
        id,
        kind: "terminal",
        pid: 100,
        running: true,
        project: null,
        paneId: null,
        agentId: null,
        agentType: null,
        task: null,
        exit: null,
        ...overrides,
    };
}

function pane(id: string, ptyId?: number): PaneNode {
    return { type: "pane", id, cwd: "/repo", kind: "terminal", title: "shell", ...(ptyId === undefined ? {} : { ptyId }) };
}

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
    return { id, type: "claude", title: id, startup: "claude", ...overrides };
}

const hiddenWindow: Window = {
    id: "win-hidden",
    name: "Terminal",
    role: "term",
    activePaneId: "a",
    root: { type: "split", id: "split", dir: "row", sizes: [0.5, 0.5], children: [pane("a", 11), pane("b")] },
};

describe("core session claims", () => {
    it("counts every saved pane and terminal agent, shown or not", () => {
        const claimed = claimedSessionIds({
            windows: { [hiddenWindow.id]: hiddenWindow },
            agents: { one: agent("one", { ptyId: 12 }), two: agent("two") },
        });
        expect([...claimed].sort()).toEqual([11, 12]);
    });

    it("stops only terminals nobody names, and leaves tasks to be taken over", () => {
        const sessions = [session(11), session(12), session(13), session(14, { kind: "task" }), session(15, { running: false })];
        expect(unclaimedTerminals(sessions, new Set([11, 12]))).toEqual([13, 15]);
    });

    it("brings agents back live only while their terminal runs", () => {
        const plan = agentSessionPlan(
            {
                agents: {
                    live: agent("live", { ptyId: 1, resumeId: "r1" }),
                    ended: agent("ended", { ptyId: 2, resumeId: "r2" }),
                    missing: agent("missing", { ptyId: 3, resumeId: "r3" }),
                    fresh: agent("fresh", { ptyId: 4 }),
                    chat: agent("chat", { resumeId: "r5" }),
                },
            },
            [session(1), session(2, { running: false }), session(4, { running: false })],
        );
        expect(plan).toEqual({ live: ["live"], gone: ["ended", "missing"], dropped: ["fresh"] });
    });

    it("gives a copied pane its own terminal", () => {
        const copy = cloneLayout(hiddenWindow.root);
        expect(copy.type === "split" && copy.children.every((child) => child.type === "pane" && child.ptyId === undefined)).toBe(true);
    });
});
