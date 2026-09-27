import { useEffect } from "react";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { copyText, notify, swallow } from "../../../plugin-api/host";
import { EmptyState, SkeletonRows, VirtualLogList } from "../../../plugin-api/ui";
import { failureMessage, type Job, type RepoRef } from "../api";
import { actionsJobLogR } from "../resources";

/** Runner logs mark their sections with `##[...]`, which is noise on screen. */
const MARKUP = /^##\[(?:group|endgroup|section|command)\]/u;
const ENDGROUP = /^##\[endgroup\]/u;

function clean(text: string): string {
    return text.replace(MARKUP, "");
}

/** A log re-reads itself while its job is still writing to it. */
const LIVE_REFRESH_MS = 5_000;

interface Props {
    repo: RepoRef;
    job: Job;
    active: boolean;
}

export function JobLogView({ repo, job, active }: Props) {
    const running = job.status !== "completed";
    const log = useResourceEnabled(active, actionsJobLogR, repo, job.id);

    // An open log follows a job that is still going, the way the run does.
    useEffect(() => {
        if (!active || !running) return;
        const timer = setInterval(() => void log.refresh(), LIVE_REFRESH_MS);
        return () => clearInterval(timer);
    }, [active, running, log]);

    if (log.status === "loading" && !log.data) return <SkeletonRows rows={12} label="Loading log" />;
    if (log.error) {
        return (
            <EmptyState
                title="Could not read the log"
                message={failureMessage(log.error)}
                tone="error"
                action={{ label: "Try again", onClick: () => void log.refresh() }}
            />
        );
    }
    if (log.data?.expired) {
        return <EmptyState title="The log is gone" message="GitHub keeps job logs for a limited time, and this one has aged out." />;
    }
    const lines = log.data?.lines ?? [];
    if (lines.length === 0) {
        return <EmptyState message={running ? "This job has not written anything yet." : "This job wrote no log."} />;
    }

    const copyAll = () =>
        void copyText(lines.map((line) => clean(line.text)).join("\n"))
            .then(() => notify("success", `Copied ${lines.length} lines`))
            .catch(swallow("copy the log"));

    return (
        <div className="gha-log">
            <div className="gha-log-head">
                <span className="gha-dim">
                    {lines.length} line{lines.length === 1 ? "" : "s"}
                    {running && " so far"}
                </span>
                <button type="button" className="gha-link" onClick={copyAll}>
                    Copy
                </button>
                <button type="button" className="gha-link" onClick={() => void log.refresh()}>
                    Refresh
                </button>
            </div>
            <VirtualLogList
                items={lines}
                className="gha-log-scroll"
                follow={running}
                getItemKey={(line) => line.number}
                rowClassName={(line) => (MARKUP.test(line.text) && !ENDGROUP.test(line.text) ? "gha-log-line group" : "gha-log-line")}
                renderRow={(line) => (
                    <>
                        <span className="gha-log-number gha-mono">{line.number}</span>
                        <span className="gha-log-text gha-mono">{clean(line.text) || " "}</span>
                    </>
                )}
            />
        </div>
    );
}
