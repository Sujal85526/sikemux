import { useEffect, useState } from "react";
import {
  awsApi,
  type EcsCluster,
  type EcsService,
  type EcsServiceLog,
  type EcsTask,
} from "../../api/aws";
import { reportError } from "../../state/toast";
import { IconChevron } from "../Icons";
import { AwsLogTailView } from "./AwsLogTailView";

interface ViewProps {
  profile: string;
}

// Drill-down state for the ECS view.
//
//   clusters → services {cluster} → service {cluster, service}
//
// `service` is a two-tab page (Logs / Tasks). Clicking a task in the Tasks
// tab filters the log tail to that task's stream — same level, just an
// extra task filter applied to the view.
type Level =
  | { kind: "clusters" }
  | { kind: "services"; cluster: string }
  | {
      kind: "service";
      cluster: string;
      service: string;
      tab: "logs" | "tasks";
      /** When set, the Logs tab filters to this task's specific stream. */
      taskFilter?: { taskId: string; stream: string };
    };

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

export function AwsEcsView({ profile }: ViewProps) {
  const [level, setLevel] = useState<Level>({ kind: "clusters" });

  return (
    <div className="aws-view">
      <Breadcrumb level={level} onJump={setLevel} />
      {level.kind === "clusters" && (
        <ClustersList
          profile={profile}
          onPick={(c) => setLevel({ kind: "services", cluster: c })}
        />
      )}
      {level.kind === "services" && (
        <ServicesList
          profile={profile}
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
          cluster={level.cluster}
          service={level.service}
          tab={level.tab}
          taskFilter={level.taskFilter}
          onTab={(tab) =>
            setLevel({ ...level, tab, taskFilter: level.taskFilter })
          }
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

function Breadcrumb({
  level,
  onJump,
}: {
  level: Level;
  onJump: (l: Level) => void;
}) {
  const parts: { label: string; jump: Level }[] = [
    { label: "Clusters", jump: { kind: "clusters" } },
  ];
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
            <button
              className="aws-breadcrumb-link"
              onClick={() => onJump(p.jump)}
            >
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
function ClustersList({
  profile,
  onPick,
}: {
  profile: string;
  onPick: (cluster: string) => void;
}) {
  const [rows, setRows] = useState<EcsCluster[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr(null);
    awsApi
      .ecsClusters(profile)
      .then((r) => !cancelled && setRows(r))
      .catch((e) => {
        if (!cancelled) {
          setErr(String(e));
          reportError("ecs clusters")(e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profile]);
  if (err) return <div className="aws-err">{err}</div>;
  if (rows === null) return <div className="aws-loading">loading clusters…</div>;
  if (rows.length === 0) return <div className="aws-empty">no clusters</div>;
  return (
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
        {rows.map((c) => (
          <tr key={c.arn} onClick={() => onPick(c.name)} className="aws-row">
            <td className="aws-col-name">{c.name}</td>
            <td>{c.services_count ?? "—"}</td>
            <td>{c.tasks_running ?? "—"}</td>
            <td>{c.tasks_pending ?? "—"}</td>
            <td>
              <span
                className={`aws-status aws-status-${c.status === "ACTIVE" ? "ok" : "off"}`}
              >
                {c.status ?? "—"}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Services in a cluster
// ---------------------------------------------------------------------------
function ServicesList({
  profile,
  cluster,
  onPick,
}: {
  profile: string;
  cluster: string;
  onPick: (service: string) => void;
}) {
  const [rows, setRows] = useState<EcsService[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr(null);
    awsApi
      .ecsServices(profile, cluster)
      .then((r) => !cancelled && setRows(r))
      .catch((e) => {
        if (!cancelled) {
          setErr(String(e));
          reportError("ecs services")(e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profile, cluster]);
  if (err) return <div className="aws-err">{err}</div>;
  if (rows === null) return <div className="aws-loading">loading services…</div>;
  if (rows.length === 0) return <div className="aws-empty">no services</div>;
  return (
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
        {rows.map((s) => {
          const st = statusOf(s);
          return (
            <tr
              key={s.arn}
              onClick={() => onPick(s.name)}
              className="aws-row"
              title="Click → service logs (live tail)"
            >
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
  );
}

// ---------------------------------------------------------------------------
// Service detail — Logs tab (default) + Tasks tab
// ---------------------------------------------------------------------------
function ServiceView({
  profile,
  cluster,
  service,
  tab,
  taskFilter,
  onTab,
  onPickTask,
  onClearFilter,
}: {
  profile: string;
  cluster: string;
  service: string;
  tab: "logs" | "tasks";
  taskFilter?: { taskId: string; stream: string };
  onTab: (t: "logs" | "tasks") => void;
  onPickTask: (taskId: string, stream: string) => void;
  onClearFilter: () => void;
}) {
  const [cfg, setCfg] = useState<EcsServiceLog | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);

  // Resolve the service's log group once. Cached for the lifetime of this
  // ServiceView instance — switching tabs or filtering tasks reuses it.
  useEffect(() => {
    let cancelled = false;
    setCfg(null);
    setCfgErr(null);
    awsApi
      .ecsServiceLogConfig(profile, cluster, service)
      .then((c) => !cancelled && setCfg(c))
      .catch((e) => {
        if (!cancelled) {
          setCfgErr(String(e));
          reportError("service log config")(e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profile, cluster, service]);

  return (
    <div className="aws-view">
      <div className="aws-subtabs">
        <button
          className={`aws-subtab${tab === "logs" ? " active" : ""}`}
          onClick={() => onTab("logs")}
        >
          Logs
        </button>
        <button
          className={`aws-subtab${tab === "tasks" ? " active" : ""}`}
          onClick={() => onTab("tasks")}
        >
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
          {cfgErr ? (
            <div className="aws-err">{cfgErr}</div>
          ) : !cfg ? (
            <div className="aws-loading">resolving service log group…</div>
          ) : (
            <AwsLogTailView
              key={`${cfg.log_group}|${taskFilter?.stream ?? ""}`}
              profile={profile}
              logGroup={cfg.log_group}
              logStream={taskFilter?.stream ?? null}
            />
          )}
        </>
      )}

      {tab === "tasks" && (
        <TasksList
          profile={profile}
          cluster={cluster}
          service={service}
          onPick={(t) => {
            // Build the task's specific stream from the service's container
            // name + task id. ECS format: <prefix>/<container>/<task-id>.
            // We don't know the prefix here without another describe call,
            // so we fall back to the existing per-task resolver.
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
function TasksList({
  profile,
  cluster,
  service,
  onPick,
}: {
  profile: string;
  cluster: string;
  service: string;
  onPick: (t: EcsTask) => void;
}) {
  const [rows, setRows] = useState<EcsTask[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr(null);
    awsApi
      .ecsTasks(profile, cluster, service)
      .then((r) => !cancelled && setRows(r))
      .catch((e) => {
        if (!cancelled) {
          setErr(String(e));
          reportError("ecs tasks")(e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profile, cluster, service]);
  if (err) return <div className="aws-err">{err}</div>;
  if (rows === null) return <div className="aws-loading">loading tasks…</div>;
  if (rows.length === 0) return <div className="aws-empty">no tasks</div>;
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
        {rows.map((t) => (
          <tr
            key={t.arn}
            className="aws-row"
            onClick={() => onPick(t)}
            title="Click → filter logs to this task"
          >
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
