import { useEffect, useMemo, useRef, useState } from "react";
import { rundeckApi, type LogEntry, type RundeckExecution as Execution, type RundeckStep, type RundeckWorkflowState } from "../../api/rundeck";
import { statusKind } from "./branchStyle";
import { swallow } from "../../state/toast";

interface Props {
    paneId: string;
    level: {
        kind: "execution";
        executionId: number;
        project: string;
        service: string;
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

export function RundeckExecution({ paneId: _paneId, level, active }: Props) {
    const [execution, setExecution] = useState<Execution | null>(null);
    const [state, setState] = useState<RundeckWorkflowState | null>(null);
    const [terminal, setTerminal] = useState(false);
    const [watchErr, setWatchErr] = useState<string | null>(null);

    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [logsCompleted, setLogsCompleted] = useState(false);
    const [followTail, setFollowTail] = useState(true);
    const [stepFilter, setStepFilter] = useState<string | null>(null);
    const [aborting, setAborting] = useState(false);

    const logRef = useRef<HTMLDivElement>(null);

    // ---- subscribe to watcher + log tail on mount; clean up on unmount ----
    //
    // The watcher polls every 1.5s; running multiple execution panes burns
    // ~6 req/s per visible exec, even when the user has tabbed away. We
    // pause both subscriptions whenever the document is hidden and restart
    // them on visibility return — the next tick re-fetches the latest
    // execution+state so the UI catches up to whatever happened while
    // hidden.
    useEffect(() => {
        if (!active) return;
        let watchId: number | undefined;
        let logsId: number | undefined;
        let alive = true;

        const start = () => {
            setEntries([]);
            setLogsCompleted(false);
            rundeckApi
                .watchStart(level.executionId, (u) => {
                    if (!alive) return;
                    if (u.execution) setExecution(u.execution);
                    if (u.state) setState(u.state);
                    setTerminal(u.terminal);
                    if (u.error) setWatchErr(u.error);
                    else setWatchErr(null);
                })
                .then((id) => {
                    watchId = id;
                })
                .catch((e) => setWatchErr(String(e)));

            // Pass null backlog → fetch from offset 0. For RUNNING executions
            // that means we get everything since start (typically KB); for OLD
            // completed runs that's what makes step 1 / step 2 log entries
            // visible (they happened long before the last 200 lines a tail-only
            // fetch would have given us).
            rundeckApi
                .logsStart(level.executionId, null, (tick) => {
                    if (!alive) return;
                    if (tick.entries.length) {
                        setEntries((prev) => prev.concat(tick.entries));
                    }
                    if (tick.completed) setLogsCompleted(true);
                })
                .then((id) => {
                    logsId = id;
                })
                .catch(swallow("rnd logs start"));
        };

        const stop = () => {
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
            else if (watchId == null && logsId == null) start();
        };
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            alive = false;
            document.removeEventListener("visibilitychange", onVisibility);
            stop();
        };
    }, [level.executionId, active]);

    // ---- auto-scroll log when followTail is on ----
    useEffect(() => {
        if (!followTail) return;
        const el = logRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [entries, followTail]);

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

    return (
        <div className="rnd-exec">
            <header className="rnd-exec-head">
                <div className="rnd-exec-head-l">
                    <span className={`rnd-exec-pill rnd-status-${sk}`}>{status}</span>
                    <span className="rnd-exec-id big">#{level.executionId}</span>
                    <span className="rnd-exec-svc">{level.service}</span>
                    <span className="rnd-exec-proj">{level.project}</span>
                </div>
                <div className="rnd-exec-head-r">
                    <span className="rnd-exec-meta">
                        <span className="rnd-meta-k">branch</span>
                        <span className="rnd-meta-v">{branch}</span>
                    </span>
                    <span className="rnd-exec-meta">
                        <span className="rnd-meta-k">user</span>
                        <span className="rnd-meta-v">{execution?.user ?? "—"}</span>
                    </span>
                    <span className="rnd-exec-meta">
                        <span className="rnd-meta-k">started</span>
                        <span className="rnd-meta-v">{started ? formatTime(started) : "—"}</span>
                    </span>
                    <span className="rnd-exec-meta">
                        <span className="rnd-meta-k">duration</span>
                        <span className="rnd-meta-v">{dur}</span>
                    </span>
                    {execution?.permalink && (
                        <a className="rnd-btn-sm" href={execution.permalink} target="_blank" rel="noreferrer" title="Open in Rundeck UI">
                            open ↗
                        </a>
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
                        {(state?.steps ?? []).map((s, i) => (
                            <StepRow key={i} idx={i} step={s} selected={stepFilter === String(i + 1)} onClick={() => setStepFilter(String(i + 1))} />
                        ))}
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
                            <input type="checkbox" checked={followTail} onChange={(e) => setFollowTail(e.target.checked)} />
                            <span>follow</span>
                        </label>
                        <span className="rnd-logs-count">{filteredEntries.length} lines</span>
                    </div>
                    <div ref={logRef} className="rnd-logs-stream">
                        {filteredEntries.length === 0 && (
                            <div className="rnd-empty muted compact">no output{stepFilter ? " for this step" : ""} yet</div>
                        )}
                        {filteredEntries.map((e, i) => (
                            <div key={i} className={`rnd-log-line${e.level ? ` lvl-${e.level.toLowerCase()}` : ""}`}>
                                <span className="rnd-log-step">{e.stepctx ? `[${e.stepctx}]` : ""}</span>
                                <span className="rnd-log-text">{e.log}</span>
                            </div>
                        ))}
                    </div>
                </section>
            </div>
        </div>
    );
}

function StepRow({ idx, step, selected, onClick }: { idx: number; step: RundeckStep; selected: boolean; onClick: () => void }) {
    // Rundeck's /state returns these flat (no stepState wrapper) — see
    // executions.rs for the API shape note.
    const stateName = step.executionState ?? "NOT_STARTED";
    const ui = STEP_STATE[stateName] ?? { label: "?", cls: "pending" as const };
    const dur = duration(step.startTime, step.endTime);
    return (
        <button className={`rnd-step${selected ? " selected" : ""} step-${ui.cls}`} onClick={onClick} title={stateName}>
            <span className="rnd-step-num">{idx + 1}</span>
            <span className={`rnd-step-glyph step-${ui.cls}`}>{ui.label}</span>
            <span className="rnd-step-label">step {step.stepctx ?? step.id ?? idx + 1}</span>
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
