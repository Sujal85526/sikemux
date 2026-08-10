import { collectPanes } from "../state/layout";
import type { Session, Window } from "../state/types";
import {
    createWorkbenchItemRef,
    workbenchItemRegistry,
    type ItemId,
    type WorkbenchItemController,
    type WorkbenchItemRef,
    type WorkbenchItemRegistry,
} from "./registry";

type LifecycleState = "active" | "inactive";

interface ItemRuntime {
    ref: WorkbenchItemRef;
    controller: WorkbenchItemController;
    lifecycle: LifecycleState;
}

export interface SessionControllerSnapshot {
    readonly sessionId: string;
    readonly itemCount: number;
    readonly activeItemId: ItemId | null;
    readonly disposed: boolean;
}

function settle(operation: void | Promise<void>): void {
    void Promise.resolve(operation).catch(() => {});
}

/** Owns runtime item controllers for one durable session topology. */
export class SessionController {
    private readonly items = new Map<ItemId, ItemRuntime>();
    private activeItemId: ItemId | null = null;
    private disposed = false;

    constructor(
        readonly sessionId: string,
        private readonly registry: Pick<WorkbenchItemRegistry, "create"> = workbenchItemRegistry,
    ) {}

    reconcile(session: Session, windows: readonly Window[], activeSessionId: string): void {
        if (this.disposed) throw new Error("cannot reconcile a disposed session controller");
        if (session.id !== this.sessionId) throw new Error("session controller received a different session");

        const next = new Map<ItemId, WorkbenchItemRef>();
        for (const window of windows) {
            for (const pane of collectPanes(window.root)) {
                const ref = createWorkbenchItemRef(pane.id, pane.kind);
                next.set(ref.id, ref);
                const current = this.items.get(ref.id);
                if (current?.ref.kind === ref.kind) continue;
                if (current) {
                    if (current.lifecycle === "active") settle(current.controller.deactivate());
                    settle(current.controller.dispose());
                }
                this.items.set(ref.id, { ref, controller: this.registry.create(ref), lifecycle: "inactive" });
            }
        }

        for (const [id, current] of this.items) {
            if (next.has(id)) continue;
            if (current.lifecycle === "active") settle(current.controller.deactivate());
            settle(current.controller.dispose());
            this.items.delete(id);
        }

        const activeWindow = windows.find((window) => window.id === session.activeWindowId);
        const activePane = activeWindow ? collectPanes(activeWindow.root).find((pane) => pane.id === activeWindow.activePaneId) : undefined;
        const nextActiveId =
            activeSessionId === session.id && session.view === "windows" && activePane
                ? createWorkbenchItemRef(activePane.id, activePane.kind).id
                : null;
        this.activeItemId = nextActiveId && this.items.has(nextActiveId) ? nextActiveId : null;

        for (const [id, current] of this.items) {
            const lifecycle: LifecycleState = id === this.activeItemId ? "active" : "inactive";
            if (lifecycle === current.lifecycle) continue;
            current.lifecycle = lifecycle;
            if (lifecycle === "active") settle(current.controller.activate());
            else settle(current.controller.deactivate());
        }
    }

    async canClose(): Promise<boolean> {
        for (const item of this.items.values()) {
            if (!(await item.controller.canClose())) return false;
        }
        return true;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const item of this.items.values()) {
            if (item.lifecycle === "active") settle(item.controller.deactivate());
            settle(item.controller.dispose());
        }
        this.items.clear();
        this.activeItemId = null;
    }

    getSnapshot(): SessionControllerSnapshot {
        return {
            sessionId: this.sessionId,
            itemCount: this.items.size,
            activeItemId: this.activeItemId,
            disposed: this.disposed,
        };
    }
}
