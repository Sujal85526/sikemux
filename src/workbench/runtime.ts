import type { StoreState } from "../state/store";
import { useStore } from "../state/store";
import { SessionController } from "./sessionController";

export interface WorkbenchRuntimeSnapshot {
    readonly sessions: number;
    readonly items: number;
    readonly started: boolean;
}

export class WorkbenchRuntime {
    private readonly sessions = new Map<string, SessionController>();
    private unsubscribe: (() => void) | null = null;

    start(): void {
        if (this.unsubscribe) return;
        this.reconcile(useStore.getState());
        this.unsubscribe = useStore.subscribe((state) => this.reconcile(state));
    }

    reconcile(state: StoreState): void {
        const live = new Set(state.sessionOrder);
        for (const sessionId of state.sessionOrder) {
            const session = state.sessions[sessionId];
            if (!session) continue;
            let controller = this.sessions.get(sessionId);
            if (!controller) {
                controller = new SessionController(sessionId);
                this.sessions.set(sessionId, controller);
            }
            const windows = (state.windowsBySession[sessionId] ?? []).map((id) => state.windows[id]).filter((window) => window !== undefined);
            controller.reconcile(session, windows, state.activeSessionId);
        }
        for (const [sessionId, controller] of this.sessions) {
            if (live.has(sessionId)) continue;
            controller.dispose();
            this.sessions.delete(sessionId);
        }
    }

    stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.sessions.forEach((controller) => controller.dispose());
        this.sessions.clear();
    }

    getSession(sessionId: string): SessionController | undefined {
        return this.sessions.get(sessionId);
    }

    getSnapshot(): WorkbenchRuntimeSnapshot {
        let items = 0;
        this.sessions.forEach((controller) => {
            items += controller.getSnapshot().itemCount;
        });
        return { sessions: this.sessions.size, items, started: this.unsubscribe !== null };
    }
}

export const workbenchRuntime = new WorkbenchRuntime();
