import { useEffect, useMemo, useState } from "react";
import { invokeCommand as invoke } from "../../api/invoke";
import { rundeckApi, type LogEntry, type RundeckExecution as Execution, type RundeckStep, type RundeckWorkflowState } from "../../api/rundeck";
import * as cmd from "../../state/commands";
import { statusKind } from "./branchStyle";
import { swallow } from "../../state/toast";
import { IconClock, IconGit, IconRun, IconTimer, IconUser } from "../Icons";
import { VirtualLogList } from "../VirtualLogList";
import { Switch } from "../Controls";

interface Props {
    paneId: string;
    level: {
        kind: "execution";
        executionId: number;
        project: string;
        service: string;
        env?: string;
        jobId?: string;
        repoPath?: string;
    };
    active: boolean;
}

const STEP_STATE: Record<string, { label: string; cls: "pending" | "running" | "ok" | "fail" | "skip" }> = {
    NOT_STARTED: { label: "·", cls: "pending" },
    WAITING: { label: "·", cls: "pending" },
    RUNNING: { label: "▶", cls: "running" },
    RUNNING_HANDLER: { label: "▶", cls: "running" },
    SUCCEEDED: { label: "✓", cls: "ok" },
    FAILED: { label: "✕", cls: "fail" },
    ABORTED: { label: "⊘", cls: "fail" },
    NOT_ELIGIBLE: { label: "—", cls: "skip" },
};

const MAX_LOG_ENTRIES = 10000;

export function RundeckExecution({ paneId, level, active }: Props) {
    const [execution, setExecution] = useState<Execution | null>(null);
    const [state, setState] = useState<RundeckWorkflowState | null>(null);
    const [terminal, setTerminal] = useState(false);
    const [watchErr, setWatchErr] = useState<string | null>(null);

    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [logsCompleted, setLogsCompleted] = useState(false);
    const [followTail, setFollowTail] = useState(true);
    const [stepFilter, setStepFilter] = useState<string | null>(null);
    const [aborting, setAborting] = useState(false);

    useEffect(() => {
        if (!active) return;
        setExecution(null);
        setState(null);
        setTerminal(false);
        setWatchErr(null);
        setEntries([]);
        setLogsCompleted(false);
        setStepFilter(null);
        let watchId: number | undefined;
        let logsId: number | undefined;
        let watchStarting = false;
        let logsStarting = false;
        let generation = 0;
        let alive = true;

        const startWatch = () => {
            if (watchId != null || watchStarting || document.hidden || !alive) return;
            const startedIn = generation;
            watchStarting = true;
            rundeckApi
                .watchStart(level.executionId, (u) => {
                    if (!alive || startedIn !== generation) return;
                    if (u.execution) setExecution(u.execution);
                    if (u.state) setState(u.state);
                    setTerminal(u.terminal);
                    if (u.error) setWatchErr(u.error);
                    else setWatchErr(null);
                })
                .then((id) => {
                    if (!alive || startedIn !== generation) void rundeckApi.watchStop(id);
                    else watchId = id;
                })
                .catch((e) => {
                    if (alive && startedIn === generation) setWatchErr(String(e));
                })
                .finally(() => {
                    watchStarting = false;
                    if (startedIn !== generation) startWatch();
                });
        };

        const startLogs = () => {
            if (logsId != null || logsStarting || document.hidden || !alive) return;
            const startedIn = generation;
            logsStarting = true;
            rundeckApi
                .logsStart(level.executionId, null, (tick) => {
                    if (!alive || startedIn !== generation) return;
                    if (tick.entries.length) {
                        setEntries((prev) => {
                            const next = prev.concat(tick.entries);
                            return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
                        });
                    }
                    if (tick.completed) setLogsCompleted(true);
                })
                .then((id) => {
                    if (!alive || startedIn !== generation) void rundeckApi.logsStop(id);
                    else logsId = id;
                })
                .catch((error) => {
                    if (alive && startedIn === generation) swallow("rnd logs start")(error);
                })
                .finally(() => {
                    logsStarting = false;
                    if (startedIn !== generation) startLogs();
                });
        };

        const start = () => {
            setEntries([]);
            setLogsCompleted(false);
            startWatch();
            startLogs();
        };

        const stop = () => {
            generation += 1;
            if (watchId != null) {
                void rundeckApi.watchStop(watchId);
                watchId = undefined;
            }
            if (logsId != null) {
                void rundeckApi.logsStop(logsId);
                logsId = undefined;
            }
        };

        if (!document.hidden) start();
        const onVisibility = () => {
            if (document.hidden) stop();
            else start();
        };
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            alive = false;
            document.removeEventListener("visibilitychange", onVisibility);
            stop();
        };
    }, [level.executionId, active]);

    const filteredEntries = useMemo(() => {
        if (!stepFilter) return entries;
        return entries.filter((e) => (e.stepctx ?? "") === stepFilter);
    }, [entries, stepFilter]);

    const status = execution?.status ?? state?.executionState ?? "unknown";
    const sk = statusKind(status);
    const branch = execution?.job?.options?.BRANCH ?? "—";
    const started = execution?.["date-started"]?.date ?? null;
    const ended = execution?.["date-ended"]?.date ?? null;
    const dur = duration(started, ended);

    const abort = async () => {
        setAborting(true);
        try {
            await rundeckApi.abort(level.executionId);
        } finally {
            setAborting(false);
        }
    };

    const replayBranch = execution?.job?.options?.BRANCH ?? "";
    const canRunAgain = !!level.jobId && !!level.env && !!replayBranch;
    const runAgain = () => {
        if (!level.jobId || !level.env || !replayBranch) return;
        cmd.rundeckPush(paneId, {
            kind: "deploy",
            env: level.env,
            project: level.project,
            service: level.service,
            jobId: level.jobId,
            branch: replayBranch,
            repoPath: level.repoPath,
        });
    };

    return (
        <div className="rnd-exec">
            <header className="rnd-exec-head">
                <div className="rnd-exec-head-l">
                    <span className={`rnd-exec-pill rnd-status-${sk}`}>{status}</span>
                </div>
                <div className="rnd-exec-head-r">
                    <div className="rnd-exec-meta-row">
                        <span className="rnd-exec-meta" title="branch">
                            <IconGit size={12} className="rnd-meta-ic branch" />
                            <span className="rnd-meta-v">{branch}</span>
                        </span>
                        <span className="rnd-exec-meta" title="triggered by">
                            <IconUser size={12} className="rnd-meta-ic" />
                            <span className="rnd-meta-v">{execution?.user ?? "—"}</span>
                        </span>
                        <span className="rnd-exec-meta" title="started">
                            <IconClock size={12} className="rnd-meta-ic" />
                            <span className="rnd-meta-v">{started ? formatTime(started) : "—"}</span>
                        </span>
                        <span className="rnd-exec-meta" title="duration">
                            <IconTimer size={12} className="rnd-meta-ic" />
                            <span className="rnd-meta-v">{dur || "—"}</span>
                        </span>
                    </div>
                    <button
                        className="rnd-btn-sm rnd-btn-primary"
                        disabled={!canRunAgain}
                        onClick={runAgain}
                        title={canRunAgain ? `Deploy ${replayBranch} again` : "Run again unavailable for this execution"}>
                        <IconRun size={11} />
                        run again
                    </button>
                    {execution?.permalink && (
                        <button
                            type="button"
                            className="rnd-btn-sm"
                            onClick={() =>
                                void invoke("open_url", { url: execution.permalink, app: null, shortcut: null }).catch(swallow("open Rundeck URL"))
                            }
                            title="Open in Rundeck UI">
                            open ↗
                        </button>
                    )}
                    {status === "running" && (
                        <button className="rnd-btn-sm rnd-btn-danger" disabled={aborting} onClick={abort}>
                            {aborting ? "aborting…" : "abort"}
                        </button>
                    )}
                </div>
            </header>

            {watchErr && <div className="rnd-banner warn">{watchErr}</div>}

            <div className="rnd-exec-body">
                <aside className="rnd-steps">
                    <div className="rnd-steps-head">
                        <span>steps</span>
                        {stepFilter && (
                            <button className="rnd-pill-x" onClick={() => setStepFilter(null)} title="Clear step filter">
                                clear filter
                            </button>
                        )}
                    </div>
                    <div className="rnd-steps-list">
                        {(state?.steps ?? []).length === 0 && <div className="rnd-empty muted compact">waiting for steps…</div>}
                        {(state?.steps ?? []).map((s, i) => {
                            const filterKey = stepFilterKey(s, i);
                            return <StepRow key={i} idx={i} step={s} selected={stepFilter === filterKey} onClick={() => setStepFilter(filterKey)} />;
                        })}
                    </div>
                </aside>

                <section className="rnd-logs">
                    <div className="rnd-logs-toolbar">
                        <span className="rnd-logs-title">
                            output
                            {stepFilter ? ` · step ${stepFilter}` : " · all steps"}
                            {logsCompleted ? " · ended" : terminal ? " · ending…" : " · live"}
                        </span>
                        <label className="rnd-toggle">
                            <span>follow</span>
                            <Switch checked={followTail} onChange={setFollowTail} label="Follow log tail" />
                        </label>
                        <span className="rnd-logs-count">{filteredEntries.length} lines</span>
                    </div>
                    <VirtualLogList
                        items={filteredEntries}
                        className="rnd-logs-stream"
                        rowClassName={(entry) => `rnd-log-line${entry.level ? ` lvl-${entry.level.toLowerCase()}` : ""}`}
                        estimateSize={20}
                        follow={followTail}
                        empty={<div className="rnd-empty muted compact">no output{stepFilter ? " for this step" : ""} yet</div>}
                        getItemKey={(entry, index) => `${entry.time ?? ""}:${entry.stepctx ?? ""}:${index}`}
                        renderRow={(entry) => (
                            <>
                                <span className="rnd-log-step">{entry.stepctx ? `[${entry.stepctx}]` : ""}</span>
                                <span className="rnd-log-text">{entry.log}</span>
                            </>
                        )}
                    />
                </section>
            </div>
        </div>
    );
}

function stepFilterKey(step: RundeckStep, idx: number): string {
    return step.stepctx ?? String(idx + 1);
}

function StepRow({ idx, step, selected, onClick }: { idx: number; step: RundeckStep; selected: boolean; onClick: () => void }) {
    const stateName = step.executionState ?? "NOT_STARTED";
    const ui = STEP_STATE[stateName] ?? { label: "?", cls: "pending" as const };
    const dur = duration(step.startTime, step.endTime);
    return (
        <button className={`rnd-step${selected ? " selected" : ""} step-${ui.cls}`} onClick={onClick} title={stateName}>
            <span className="rnd-step-num">{idx + 1}</span>
            <span className={`rnd-step-glyph step-${ui.cls}`}>{ui.label}</span>
            <span className="rnd-step-label">step {stepFilterKey(step, idx)}</span>
            <span className="rnd-step-dur">{dur}</span>
        </button>
    );
}

function formatTime(iso: string): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    return new Date(t).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function duration(start: string | null, end: string | null): string {
    if (!start) return "";
    const a = Date.parse(start);
    const b = end ? Date.parse(end) : Date.now();
    if (Number.isNaN(a) || Number.isNaN(b)) return "";
    const s = Math.max(0, Math.round((b - a) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m}m ${rest}s` : `${m}m`;
}
