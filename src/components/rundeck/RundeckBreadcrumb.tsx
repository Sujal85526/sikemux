import { useState } from "react";
import { type RundeckStatus } from "../../api/rundeck";
import * as cmd from "../../state/commands";
import { getState, useStore } from "../../state/store";
import { IconChevron } from "../Icons";

interface Props {
  paneId: string;
  status: RundeckStatus | null;
}

/** Top bar: chevron breadcrumb of the nav stack + env picker on the right.
 *  No logout — invalid tokens auto-redirect via the rnd-auth-expired bus. */
export function RundeckBreadcrumb({ paneId, status }: Props) {
  const view = useStore((s) => s.rundeckViews[paneId]);
  const stack = view?.stack ?? [{ kind: "matrix" as const }];

  const labels = stack.map((lvl, i) => {
    switch (lvl.kind) {
      case "matrix":
        return { i, label: "deployments", onClick: () => cmd.rundeckHome(paneId) };
      case "service":
        return {
          i,
          label: `${lvl.env} · ${lvl.service}`,
          onClick: () => popTo(paneId, i),
        };
      case "deploy":
        return {
          i,
          label: `deploy ${lvl.service} → ${lvl.env}`,
          onClick: () => popTo(paneId, i),
        };
      case "execution":
        return {
          i,
          label: `#${lvl.executionId} · ${lvl.service}`,
          onClick: () => popTo(paneId, i),
        };
    }
  });

  return (
    <div className="rnd-bar">
      <button
        className="rnd-bar-back"
        title="Back"
        disabled={stack.length <= 1}
        onClick={() => cmd.rundeckPop(paneId)}
      >
        <span style={{ transform: "rotate(90deg)", display: "inline-flex" }}>
          <IconChevron size={11} />
        </span>
      </button>
      <div className="rnd-bar-trail">
        {labels.map((l, idx) => (
          <span key={l.i} className="rnd-crumb-row">
            {idx > 0 && (
              <span className="rnd-crumb-sep">
                <IconChevron size={9} />
              </span>
            )}
            <button
              className={`rnd-crumb${idx === labels.length - 1 ? " current" : ""}`}
              onClick={l.onClick}
              disabled={idx === labels.length - 1}
            >
              {l.label}
            </button>
          </span>
        ))}
      </div>
      <div className="rnd-bar-right">
        {status?.url && (
          <span className="rnd-host" title={`${status.user ?? ""}@${status.url}`}>
            {hostFromUrl(status.url)}
          </span>
        )}
        <RundeckEnvPicker />
      </div>
    </div>
  );
}

/** Identical look to TopBar's env-dd, but writes to rundeck.activeEnv
 *  instead of session.env. */
function RundeckEnvPicker() {
  const activeEnv = useStore((s) => s.rundeck.activeEnv);
  const envs = useStore((s) => s.rundeck.envs);
  const [open, setOpen] = useState(false);
  return (
    <div className="env-dd">
      <button
        className="env-dd-btn"
        onClick={() => setOpen((v) => !v)}
        title="Switch environment"
      >
        <span className={`env-dot ${activeEnv}`} />
        {activeEnv}
        <IconChevron size={10} className="env-dd-chev" />
      </button>
      {open && (
        <>
          <div className="env-dd-scrim" onClick={() => setOpen(false)} />
          <div className="env-dd-menu">
            {envs.map((e) => (
              <button
                key={e.label}
                className={`env-dd-item${activeEnv === e.label ? " active" : ""}`}
                onClick={() => {
                  cmd.setRundeckEnv(e.label);
                  setOpen(false);
                }}
              >
                <span className={`env-dot ${e.label}`} />
                <span>{e.label}</span>
                <span className="env-dd-item-proj">{e.project}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function popTo(paneId: string, index: number) {
  for (let i = 0; i < 32; i += 1) {
    const v = getState().rundeckViews[paneId];
    if (!v || v.stack.length - 1 <= index) break;
    cmd.rundeckPop(paneId);
  }
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
