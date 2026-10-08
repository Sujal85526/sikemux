import { notify, notifyDesktop, swallow } from "../../plugin-api/host";
import { invalidate } from "../../plugin-api/resources";
import { rundeckApi, type RundeckExecution } from "./api";
import { runNotice } from "./runNotice";
import { openRundeckExecution, rundeckSettings, type JobRef } from "./state";

const watching = new Set<number>();

/**
 * Follows a run the person started until it ends, wherever they are in the app, then tells them how it went:
 * a toast inside Sikemux, and a desktop notification when Sikemux is in the background.
 */
export async function watchRun(job: JobRef, executionId: number, hasFocus: () => boolean = () => document.hasFocus()): Promise<void> {
    if (watching.has(executionId)) return;
    watching.add(executionId);
    let streamId: number | null = null;
    let ended = false;
    const stop = () => {
        watching.delete(executionId);
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
        watching.delete(executionId);
        throw error;
    }
}
