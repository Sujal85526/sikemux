import { create } from "zustand";
import { notify, notifyDesktop, swallow } from "../../plugin-api/host";
import { invalidate } from "../../plugin-api/resources";
import { rundeckApi, type RundeckExecution } from "./api";
import { runNotice } from "./runNotice";
import { openRundeckExecution, rundeckSettings, type JobRef } from "./state";

const useWatching = create<{ ids: ReadonlySet<number> }>(() => ({ ids: new Set() }));

const setWatching = (id: number, on: boolean) =>
    useWatching.setState(({ ids }) => {
        const next = new Set(ids);
        if (on) next.add(id);
        else next.delete(id);
        return { ids: next };
    });

/** Whether Sikemux will say when this run ends. */
export const useWatchingRun = (executionId: number): boolean => useWatching((state) => state.ids.has(executionId));

/**
 * Follows a run the person started until it ends, wherever they are in the app, then tells them how it went:
 * a toast inside Sikemux, and a desktop notification when Sikemux is in the background.
 */
export async function watchRun(job: JobRef, executionId: number, hasFocus: () => boolean = () => document.hasFocus()): Promise<void> {
    if (useWatching.getState().ids.has(executionId)) return;
    setWatching(executionId, true);
    let streamId: number | null = null;
    let ended = false;
    const stop = () => {
        setWatching(executionId, false);
        if (streamId !== null) void rundeckApi.watchStop(streamId).catch(swallow("stop watching a run"));
    };
    const finish = (execution: RundeckExecution) => {
        ended = true;
        stop();
        invalidate((kind, args) => (kind === "rnd.executions" && args[0] === job.jobId) || (kind === "rnd.matrix" && args[0] === job.project));
        if (!rundeckSettings.get().notifyWhenDone) return;
        const notice = runNotice(execution, rundeckSettings.get().branchOptions);
        notify(notice.ok ? "success" : "error", notice.title, { action: { label: "Open", run: () => openRundeckExecution(job, executionId) } });
        if (!hasFocus()) void notifyDesktop(notice.title, notice.body).catch(swallow("notify that a run ended"));
    };
    try {
        streamId = await rundeckApi.watchStart(executionId, (update) => {
            if (!ended && update.terminal && update.execution) finish(update.execution);
        });
        if (ended) stop();
    } catch (error) {
        setWatching(executionId, false);
        throw error;
    }
}
