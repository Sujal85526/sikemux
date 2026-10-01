import { coreSessionsApi, type CoreSession } from "../api/coreSessions";
import * as cmd from "../state/commands";
import { agentSessionPlan, claimedSessionIds, unclaimedTerminals } from "../state/coreSessionClaims";
import { getState, setState } from "../state/store";
import { notify } from "../state/toast";
import { adoptCoreTasks, type TaskAdoptionTargets } from "../tasks/adoption";
import { appTaskRuntime } from "../tasks/application";
import { NativeTaskExecutionBackend } from "../tasks/nativeRuntime";
import { offerResumableSessions, spawnedThisPage } from "../terminal/sessionResume";

/** Long enough for every pane of a restored layout to have taken its terminal back. */
export const UNCLAIMED_GRACE_MS = 30_000;

export const KEPT_RUNNING_NOTICE = "Your terminals kept running while Sikemux was closed. Use Quit and Stop Everything (⌥⌘Q) to stop them.";

/** Call right after the saved layout is applied, before any pane mounts. */
export function offerSavedSessions(): void {
    offerResumableSessions(claimedSessionIds(getState()));
}

export interface CoreSessionRestoreDeps {
    list(): Promise<CoreSession[]>;
    kill(id: number): Promise<void>;
    tasks: TaskAdoptionTargets;
    schedule(callback: () => void, delayMs: number): void;
}

function defaultDeps(): CoreSessionRestoreDeps {
    const backend = new NativeTaskExecutionBackend();
    return {
        list: coreSessionsApi.list,
        kill: coreSessionsApi.kill,
        tasks: {
            watch: (ptyId) => backend.watch(ptyId),
            adoptDeckTask: (task, executionId, started) => appTaskRuntime.adopt(task, executionId, started),
            adoptHarnessRun: (adoption, started) =>
                void import("../harness/service").then(({ harnessTasks }) => harnessTasks.adopt(adoption, started)).catch(() => {}),
        },
        schedule: (callback, delayMs) => void window.setTimeout(callback, delayMs),
    };
}

/**
 * Takes back what the core kept while the app was closed or reloading:
 * terminal agents still running come back live, tasks rejoin the command deck
 * and the harness, and terminals from before this page that nothing in the
 * layout names are stopped after a grace, so none of them runs forever unseen.
 */
export async function restoreCoreSessions(deps: CoreSessionRestoreDeps = defaultDeps()): Promise<void> {
    let sessions: CoreSession[];
    try {
        sessions = await deps.list();
    } catch {
        return;
    }
    cmd.applyAgentSessionPlan(agentSessionPlan(getState(), sessions));
    const tasks = await adoptCoreTasks(sessions, deps.tasks);

    const claimed = claimedSessionIds(getState());
    const earlier = sessions.filter((session) => !spawnedThisPage(session.id));
    const terminals = earlier.filter((session) => session.kind === "terminal" && session.running && claimed.has(session.id)).length;
    if (terminals + tasks > 0 && !getState().keptRunningNoticeShown) {
        setState({ keptRunningNoticeShown: true });
        notify("info", KEPT_RUNNING_NOTICE, { timeoutMs: 12_000 });
    }

    const candidates = unclaimedTerminals(earlier, claimed);
    if (candidates.length === 0) return;
    deps.schedule(() => {
        const stillClaimed = claimedSessionIds(getState());
        for (const id of candidates) if (!stillClaimed.has(id)) void deps.kill(id).catch(() => {});
    }, UNCLAIMED_GRACE_MS);
}
