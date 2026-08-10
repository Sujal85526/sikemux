import { describe, expect, it, vi } from "vitest";
import type { Session, Window } from "../state/types";
import { WorkbenchItemRegistry, type WorkbenchItemController } from "./registry";
import { SessionController } from "./sessionController";

const session = (activeWindowId = "window-1"): Session => ({
    id: "session-1",
    name: "repo",
    kind: "project",
    cwd: "/repo",
    pinned: false,
    activeWindowId,
    activeAgentId: null,
    view: "windows",
});

const window = (paneId: string, kind: "terminal" | "editor" = "terminal"): Window => ({
    id: "window-1",
    name: "term",
    role: "term",
    activePaneId: paneId,
    root: { type: "pane", id: paneId, cwd: "/repo", kind, title: paneId },
});

function harness() {
    const events: string[] = [];
    const created = new Map<string, WorkbenchItemController>();
    const registry = new WorkbenchItemRegistry();
    const originalCreate = registry.create.bind(registry);
    vi.spyOn(registry, "create").mockImplementation((ref) => {
        const base = originalCreate(ref);
        const controller: WorkbenchItemController = {
            activate: () => {
                events.push(`activate:${ref.id}`);
            },
            deactivate: () => {
                events.push(`deactivate:${ref.id}`);
            },
            canClose: base.canClose,
            dispose: () => {
                events.push(`dispose:${ref.id}`);
            },
        };
        created.set(ref.id, controller);
        return controller;
    });
    return { registry, events, created };
}

describe("SessionController", () => {
    it("creates once, changes activation once, and disposes removed items", () => {
        const { registry, events } = harness();
        const controller = new SessionController("session-1", registry);
        controller.reconcile(session(), [window("pane-1")], "session-1");
        controller.reconcile(session(), [window("pane-1")], "session-1");
        expect(controller.getSnapshot()).toMatchObject({ itemCount: 1, activeItemId: "pane-1" });
        expect(events).toEqual(["activate:pane-1"]);

        controller.reconcile(session(), [window("pane-2", "editor")], "session-1");
        expect(events).toEqual(["activate:pane-1", "deactivate:pane-1", "dispose:pane-1", "activate:pane-2"]);
    });

    it("deactivates when its session backgrounds and disposes idempotently", () => {
        const { registry, events } = harness();
        const controller = new SessionController("session-1", registry);
        controller.reconcile(session(), [window("pane-1")], "session-1");
        controller.reconcile(session(), [window("pane-1")], "another-session");
        controller.dispose();
        controller.dispose();
        expect(events).toEqual(["activate:pane-1", "deactivate:pane-1", "dispose:pane-1"]);
        expect(controller.getSnapshot()).toMatchObject({ itemCount: 0, activeItemId: null, disposed: true });
    });

    it("honors close guards", async () => {
        const { registry, created } = harness();
        const controller = new SessionController("session-1", registry);
        controller.reconcile(session(), [window("pane-1")], "session-1");
        vi.spyOn(created.get("pane-1")!, "canClose").mockReturnValue(false);
        await expect(controller.canClose()).resolves.toBe(false);
    });
});
