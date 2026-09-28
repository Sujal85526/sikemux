import { useEffect, useMemo, useState } from "react";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { copyText, notify, swallow } from "../../../plugin-api/host";
import { EmptyState, SkeletonRows, VirtualLogList } from "../../../plugin-api/ui";
import { failureMessage, type Job, type RepoRef } from "../api";
import { stepStarts } from "../jobGraph";
import { actionsJobLogR } from "../resources";
import { useEvery } from "./hooks";

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
    /** The step somebody picked, whose part of the log to scroll to. */
    step: { number: number } | null;
}

export function JobLogView({ repo, job, active, step }: Props) {
    const running = job.status !== "completed";
    const log = useResourceEnabled(active, actionsJobLogR, repo, job.id);
    const [query, setQuery] = useState("");
    const [match, setMatch] = useState(0);
    const [jump, setJump] = useState<{ index: number } | null>(null);
    const [stepLine, setStepLine] = useState<number | null>(null);

    // An open log follows a job that is still going, the way the run does.
    useEvery(active && running, LIVE_REFRESH_MS, () => void log.refresh());

    const lines = useMemo(() => log.data?.lines ?? [], [log.data]);
    const starts = useMemo(() => stepStarts(lines, job.steps), [lines, job.steps]);
    const needle = query.trim().toLowerCase();
    const matches = useMemo(() => {
        if (!needle) return [];
        const found: number[] = [];
        lines.forEach((line, index) => {
            if (line.text.toLowerCase().includes(needle)) found.push(index);
        });
        return found;
    }, [lines, needle]);
    const matched = useMemo(() => new Set(matches), [matches]);

    useEffect(() => {
        if (!step) return;
        const index = starts.get(step.number);
        if (index === undefined) return;
        setStepLine(index);
        setJump({ index });
    }, [step, starts]);

    const goTo = (next: number) => {
        if (matches.length === 0) return;
        const wrapped = (next + matches.length) % matches.length;
        setMatch(wrapped);
        setJump({ index: matches[wrapped] ?? 0 });
    };

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
    if (lines.length === 0) {
        return <EmptyState message={running ? "This job has not written anything yet." : "This job wrote no log."} />;
    }

    const copyAll = () =>
        void copyText(lines.map((line) => clean(line.text)).join("\n"))
            .then(() => notify("success", `Copied ${lines.length} lines`))
            .catch(swallow("copy the log"));

    const current = matches[match] ?? -1;
    return (
        <div className="gha-log">
            <div className="gha-log-head">
                <input
                    className="gha-log-search"
                    type="search"
                    placeholder="Search the log"
                    value={query}
                    spellCheck={false}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setMatch(0);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        goTo(event.shiftKey ? match - 1 : match + 1);
                    }}
                />
                {needle && <span className="gha-dim gha-mono">{matches.length === 0 ? "no matches" : `${match + 1} of ${matches.length}`}</span>}
                {matches.length > 1 && (
                    <>
                        <button type="button" className="gha-link" onClick={() => goTo(match - 1)}>
                            Previous
                        </button>
                        <button type="button" className="gha-link" onClick={() => goTo(match + 1)}>
                            Next
                        </button>
                    </>
                )}
                <span className="gha-log-spacer" />
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
                follow={running && !jump && !needle}
                jumpTo={jump}
                getItemKey={(line) => line.number}
                rowClassName={(line, index) => {
                    const group = MARKUP.test(line.text) && !ENDGROUP.test(line.text) ? " group" : "";
                    const hit = index === current ? " hit current" : matched.has(index) ? " hit" : "";
                    const anchor = index === stepLine ? " anchor" : "";
                    return `gha-log-line${group}${hit}${anchor}`;
                }}
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
