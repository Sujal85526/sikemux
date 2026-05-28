import { useResourceEnabled } from "../../state/resources";
import { ecsClustersR, ecsServiceLogConfigR, ecsServicesR, ecsTasksR } from "../../state/resources.defs";
import { awsApi, type EcsService, type EcsTask } from "../../api/aws";
import { reportError } from "../../state/toast";
import * as cmd from "../../state/commands";
import { useStore } from "../../state/store";
import type { EcsLevel } from "../../state/types";
import { IconChevron } from "../Icons";
import { AwsLogTailView } from "./AwsLogTailView";
import { AwsRefresh } from "./AwsRefresh";

interface ViewProps {
    profile: string;
    active: boolean;
}

function relative(iso: string | null): string {
    if (!iso) return "—";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "—";
    const d = Math.max(0, (Date.now() - t) / 1000);
    if (d < 60) return `${Math.floor(d)}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
    return `${Math.floor(d / (86400 * 30))}mo ago`;
}

function statusOf(s: EcsService): "ok" | "warn" | "fail" | "off" {
    const desired = s.desired ?? 0;
    const running = s.running ?? 0;
    const pending = s.pending ?? 0;
    if (pending > 0) return "warn";
    if (desired === 0 && running === 0) return "off";
    if (running === desired && desired > 0) return "ok";
    return "fail";
}

// Drill-down state lives in the store, keyed by profile. Switching profile
// → fresh "clusters" view. Re-mounting the pane preserves where you were.
const DEFAULT_LEVEL: EcsLevel = { kind: "clusters" };

export function AwsEcsView({ profile, active }: ViewProps) {
    const level = useStore((s) => s.ecsViews[profile] ?? DEFAULT_LEVEL);
    const setLevel = (l: EcsLevel) => cmd.setEcsLevel(profile, l);

    return (
        <div className="aws-view">
            <Breadcrumb level={level} onJump={setLevel} />
            {level.kind === "clusters" && <ClustersList profile={profile} active={active} onPick={(c) => setLevel({ kind: "services", cluster: c })} />}
            {level.kind === "services" && (
                <ServicesList
                    profile={profile}
                    active={active}
                    cluster={level.cluster}
                    onPick={(s) =>
                        setLevel({
                            kind: "service",
                            cluster: level.cluster,
                            service: s,
                            tab: "logs",
                        })
                    }
                />
            )}
            {level.kind === "service" && (
                <ServiceView
                    profile={profile}
                    active={active}
                    cluster={level.cluster}
                    service={level.service}
                    tab={level.tab}
                    taskFilter={level.taskFilter}
                    onTab={(tab) => setLevel({ ...level, tab, taskFilter: level.taskFilter })}
                    onPickTask={(taskId, stream) =>
                        setLevel({
                            kind: "service",
                            cluster: level.cluster,
                            service: level.service,
                            tab: "logs",
                            taskFilter: { taskId, stream },
                        })
                    }
                    onClearFilter={() =>
                        setLevel({
                            kind: "service",
                            cluster: level.cluster,
                            service: level.service,
                            tab: level.tab,
                        })
                    }
                />
            )}
        </div>
    );
}

function Breadcrumb({ level, onJump }: { level: EcsLevel; onJump: (l: EcsLevel) => void }) {
    const parts: { label: string; jump: EcsLevel }[] = [{ label: "Clusters", jump: { kind: "clusters" } }];
    if (level.kind !== "clusters") {
        parts.push({
            label: level.cluster,
            jump: { kind: "services", cluster: level.cluster },
        });
    }
    if (level.kind === "service") {
        parts.push({
            label: level.service,
            jump: {
                kind: "service",
                cluster: level.cluster,
                service: level.service,
                tab: "logs",
            },
        });
        if (level.taskFilter) {
            parts.push({
                label: level.taskFilter.taskId.slice(0, 12),
                jump: level,
            });
        }
    }
    return (
        <div className="aws-breadcrumb">
            {parts.map((p, i) => (
                <span className="aws-breadcrumb-seg" key={i}>
                    {i > 0 && <IconChevron size={11} className="aws-breadcrumb-sep" />}
                    {i < parts.length - 1 ? (
                        <button className="aws-breadcrumb-link" onClick={() => onJump(p.jump)}>
                            {p.label}
                        </button>
                    ) : (
                        <span className="aws-breadcrumb-here">{p.label}</span>
                    )}
                </span>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------
function ClustersList({ profile, active, onPick }: { profile: string; active: boolean; onPick: (cluster: string) => void }) {
    const handle = useResourceEnabled(active, ecsClustersR, profile);
    const { data, error, status } = handle;
    if (status === "error" && error)
        return (
            <>
                <AwsRefresh handle={handle} />
                <div className="aws-err">{error}</div>
            </>
        );
    if (!data)
        return (
            <>
                <AwsRefresh handle={handle} />
                <div className="aws-loading">loading clusters…</div>
            </>
        );
    if (data.length === 0)
        return (
            <>
                <AwsRefresh handle={handle} />
                <div className="aws-empty">no clusters</div>
            </>
        );
    return (
        <>
            <AwsRefresh handle={handle} />
            <table className="aws-table">
                <thead>
                    <tr>
                        <th className="aws-col-name">Cluster</th>
                        <th>Services</th>
                        <th>Running</th>
                        <th>Pending</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    {data.map((c) => (
                        <tr key={c.arn} onClick={() => onPick(c.name)} className="aws-row">
                            <td className="aws-col-name">{c.name}</td>
                            <td>{c.services_count ?? "—"}</td>
                            <td>{c.tasks_running ?? "—"}</td>
                            <td>{c.tasks_pending ?? "—"}</td>
                            <td>
                                <span className={`aws-status aws-status-${c.status === "ACTIVE" ? "ok" : "off"}`}>{c.status ?? "—"}</span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </>
    );
}

// ---------------------------------------------------------------------------
// Services in a cluster
// ---------------------------------------------------------------------------
function ServicesList({ profile, active, cluster, onPick }: { profile: string; active: boolean; cluster: string; onPick: (service: string) => void }) {
    const handle = useResourceEnabled(active, ecsServicesR, profile, cluster);
    const { data, error, status } = handle;
    const refresh = <AwsRefresh handle={handle} />;
    if (status === "error" && error)
        return (
            <>
                {refresh}
                <div className="aws-err">{error}</div>
            </>
        );
    if (!data)
        return (
            <>
                {refresh}
                <div className="aws-loading">loading services…</div>
            </>
        );
    if (data.length === 0)
        return (
            <>
                {refresh}
                <div className="aws-empty">no services</div>
            </>
        );
    return (
        <>
            {refresh}
            <table className="aws-table">
                <thead>
                    <tr>
                        <th className="aws-col-name">Service</th>
                        <th>Running</th>
                        <th>Desired</th>
                        <th>Pending</th>
                        <th>Updated</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    {data.map((s) => {
                        const st = statusOf(s);
                        return (
                            <tr key={s.arn} onClick={() => onPick(s.name)} className="aws-row" title="Click → service logs (live tail)">
                                <td className="aws-col-name">{s.name}</td>
                                <td>{s.running ?? 0}</td>
                                <td>{s.desired ?? 0}</td>
                                <td>{s.pending ?? 0}</td>
                                <td>{relative(s.primary_updated_at ?? s.primary_created_at)}</td>
                                <td>
                                    <span className={`aws-status aws-status-${st}`}>{st}</span>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </>
    );
}

// ---------------------------------------------------------------------------
// Service detail — Logs tab (default) + Tasks tab
// ---------------------------------------------------------------------------
function ServiceView({
    profile,
    active,
    cluster,
    service,
    tab,
    taskFilter,
    onTab,
    onPickTask,
    onClearFilter,
}: {
    profile: string;
    active: boolean;
    cluster: string;
    service: string;
    tab: "logs" | "tasks";
    taskFilter?: { taskId: string; stream: string };
    onTab: (t: "logs" | "tasks") => void;
    onPickTask: (taskId: string, stream: string) => void;
    onClearFilter: () => void;
}) {
    const cfg = useResourceEnabled(active, ecsServiceLogConfigR, profile, cluster, service);

    return (
        <div className="aws-view">
            <div className="aws-subtabs">
                <button className={`aws-subtab${tab === "logs" ? " active" : ""}`} onClick={() => onTab("logs")}>
                    Logs
                </button>
                <button className={`aws-subtab${tab === "tasks" ? " active" : ""}`} onClick={() => onTab("tasks")}>
                    Tasks
                </button>
                {taskFilter && tab === "logs" && (
                    <div className="aws-subtab-filter">
                        filtered to <code>{taskFilter.taskId.slice(0, 12)}</code>
                        <button className="aws-subtab-clear" onClick={onClearFilter}>
                            clear ✕
                        </button>
                    </div>
                )}
            </div>

            {tab === "logs" && (
                <>
                    {cfg.error ? (
                        <div className="aws-err">{cfg.error}</div>
                    ) : !cfg.data ? (
                        <div className="aws-loading">resolving service log group…</div>
                    ) : (
                        <AwsLogTailView
                            key={`${cfg.data.log_group}|${taskFilter?.stream ?? ""}`}
                            profile={profile}
                            logGroup={cfg.data.log_group}
                            logStream={taskFilter?.stream ?? null}
                            active={active}
                        />
                    )}
                </>
            )}

            {tab === "tasks" && (
                <TasksList
                    profile={profile}
                    active={active}
                    cluster={cluster}
                    service={service}
                    onPick={(t) => {
                        void awsApi
                            .ecsTaskLogConfig(profile, cluster, t.arn)
                            .then((cfg) => onPickTask(t.task_id, cfg.log_stream))
                            .catch((e) => reportError("task log config")(e));
                    }}
                />
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Tasks list
// ---------------------------------------------------------------------------
function TasksList({ profile, active, cluster, service, onPick }: { profile: string; active: boolean; cluster: string; service: string; onPick: (t: EcsTask) => void }) {
    const { data, error, status } = useResourceEnabled(active, ecsTasksR, profile, cluster, service);
    if (status === "error" && error) return <div className="aws-err">{error}</div>;
    if (!data) return <div className="aws-loading">loading tasks…</div>;
    if (data.length === 0) return <div className="aws-empty">no tasks</div>;
    return (
        <table className="aws-table">
            <thead>
                <tr>
                    <th className="aws-col-name">Task</th>
                    <th>Status</th>
                    <th>Health</th>
                    <th>CPU</th>
                    <th>Mem</th>
                    <th>Started</th>
                </tr>
            </thead>
            <tbody>
                {data.map((t) => (
                    <tr key={t.arn} className="aws-row" onClick={() => onPick(t)} title="Click → filter logs to this task">
                        <td className="aws-col-name">{t.task_id.slice(0, 12)}</td>
                        <td>{t.status ?? "—"}</td>
                        <td>{t.health_status ?? "—"}</td>
                        <td>{t.cpu ?? "—"}</td>
                        <td>{t.memory ?? "—"}</td>
                        <td>{relative(t.started_at)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
