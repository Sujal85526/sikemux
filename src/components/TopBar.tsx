import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { installPendingUpdate } from "../api/updater";
import { useBattery } from "../hooks/useBattery";
import { useClock } from "../hooks/useClock";
import { ENVS } from "../state/types";
import * as cmd from "../state/commands";
import { useResource } from "../state/resources";
import { awsIdentityR, rndMatrixR } from "../state/resources.defs";
import { legacyProjectForEnv } from "../state/rundeckShape";
import { useStore } from "../state/store";
import {
  IconBattery,
  IconChevron,
  IconCommand,
  IconFolder,
  IconPanelLeft,
  IconPanelRight,
  IconRundeck,
  IconZoom,
  Logo,
  WindowIcon,
} from "./Icons";
import { useMemo } from "react";
import { branchKind, statusKind } from "./rundeck/branchStyle";

const time2 = (n: number) => String(n).padStart(2, "0");

// 12-hour parts: (12h-hour, minute, ampm). 0 → 12am, 12 → 12pm, 13 → 1pm…
function twelveHour(d: Date): { h: number; m: number; ap: "am" | "pm" } {
  const h24 = d.getHours();
  const h = h24 % 12 || 12;
  return { h, m: d.getMinutes(), ap: h24 >= 12 ? "pm" : "am" };
}

// Always-visible AWS status chip. Click → opens (or focuses) the AWS
// session; if the profile is expired, opens the sign-in modal instead.
// The shared awsIdentityR resource refetches every 60s — both this chip
// and the AwsPane subscribe to the same cache entry.
function AwsChip() {
  const profile = useStore((s) => s.awsProfile);
  const identity = useResource(awsIdentityR, profile ?? "", false);
  const status = profile ? identity.data?.status : undefined;

  const dotClass =
    status === "authed"
      ? "ok"
      : identity.status === "loading"
        ? "checking"
        : status === "expired" || status === "no-credentials"
          ? "fail"
          : !profile
            ? "off"
            : "warn";

  const onClick = () => {
    if (!profile) {
      cmd.openAwsSession();
      return;
    }
    if (status === "expired" || status === "no-credentials") {
      cmd.openAwsAuthModal(profile, null);
      return;
    }
    cmd.openAwsSession();
  };

  return (
    <button className="tb-aws-chip" onClick={onClick} title="AWS">
      <CloudIcon size={14} />
      <span className="tb-aws-label">
        {profile ? profile.slice(0, 18) : "aws"}
      </span>
      <span className={`tb-aws-dot ${dotClass}`} />
    </button>
  );
}

// Project-session deploy chip. Subscribes to rndMatrixR for the active env
// and surfaces the matching service row (basename(cwd)). Click → opens
// (or focuses) the Rundeck pane and pre-navigates to the deploy view for
// this service in this env. Same auto-detection model as `rnd deploy`
// without args in the bash CLI.
function DeployChip({
  service,
  envLabel,
  project,
}: {
  service: string;
  envLabel: string;
  project: string;
}) {
  // Same cache entry the Rundeck pane uses → no extra fetch when both are open.
  const spec = useMemo(
    () => [{ label: envLabel, project, only_succeeded: true }],
    [envLabel, project],
  );
  const res = useResource(rndMatrixR, spec);
  const cell = res.data?.envs[0]?.cells.find((c) => c.service === service);

  const branch = cell?.branch ?? null;
  const k = branchKind(branch);
  const sk = statusKind(cell?.status);
  const loading = res.status === "loading" && !res.data;

  const onClick = () => {
    void cmd.openRundeckServiceFor(service, envLabel);
  };

  const hasDeploy = !!cell && !!branch;
  return (
    <button
      className="tb-deploy-chip"
      onClick={onClick}
      title={
        hasDeploy
          ? `Last deploy: ${cell!.status ?? "?"} · ${branch}`
          : `No deploy history for ${service} on ${envLabel}`
      }
    >
      <IconRundeck size={12} />
      <span className="tb-deploy-svc">{service}</span>
      {loading ? (
        <span className="tb-deploy-meta muted">…</span>
      ) : hasDeploy ? (
        <>
          <span className="tb-deploy-sep">·</span>
          <span className={`tb-deploy-branch rnd-branch-${k}`}>{branch}</span>
          <span className={`tb-deploy-dot rnd-status-${sk}`} />
        </>
      ) : null}
    </button>
  );
}

function CloudIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M19 18H6a4 4 0 0 1-.7-7.94 6 6 0 0 1 11.43-1.39A4.5 4.5 0 0 1 19 18z" />
    </svg>
  );
}

function CogIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// App version pill — read from the bundled Info.plist via Tauri's app API,
// so it always reflects the actually-running binary (after an OTA update
// completes + relaunches, this flips automatically to the new version).
function VersionChip() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  if (!version) return null;
  return (
    <span className="tb-version" title={`Sikemux ${version}`}>
      v{version}
    </span>
  );
}

// Update chip — surfaces store.pendingUpdate. Hidden when no update;
// renders when one is available so the user can re-trigger install at
// any time after the boot prompt. States: available | installing | error.
function UpdateChip() {
  const pending = useStore((s) => s.pendingUpdate);
  if (!pending) return null;

  const state = pending.state;
  const onClick = () => {
    if (state === "installing") return;
    void installPendingUpdate();
  };

  return (
    <button
      className={`tb-update tb-update-${state}`}
      onClick={onClick}
      disabled={state === "installing"}
      title={
        state === "error"
          ? `Update v${pending.version} failed — ${pending.error ?? "unknown"}. Click to retry.`
          : state === "installing"
            ? `Installing v${pending.version}…`
            : `Update v${pending.version} available (current: v${pending.currentVersion}). Click to install + relaunch.${pending.notes ? `\n\n${pending.notes}` : ""}`
      }
    >
      <UpdateArrow size={11} />
      <span className="tb-update-label">
        {state === "installing"
          ? "installing"
          : state === "error"
            ? "retry"
            : `v${pending.version}`}
      </span>
    </button>
  );
}

function UpdateArrow({ size = 12 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2v9M4 7l4 4 4-4M3 14h10" />
    </svg>
  );
}

// macOS battery glyph + percentage — no chrome. Color uses --acc by default,
// shifting to warn at ≤20% and danger at ≤10%. Hidden on desktops (no batt).
function BatteryChip() {
  const batt = useBattery();
  if (!batt || batt.percent == null) return null;
  const pct = batt.percent;
  const tone = pct <= 10 ? "danger" : pct <= 20 ? "warn" : "ok";
  return (
    <span
      className={`tb-batt tb-batt-${tone}${batt.charging ? " charging" : ""}`}
      title={
        batt.time_remaining
          ? `${pct}% · ${batt.time_remaining} remaining`
          : `${pct}%${batt.charging ? " · charging" : ""}`
      }
    >
      <IconBattery size={11} percent={pct} charging={batt.charging} />
      <span className="tb-batt-pct">{pct}%</span>
    </span>
  );
}

export function TopBar() {
  const now = useClock();
  const t = twelveHour(now);
  const session = useStore((s) => s.sessions[s.activeSessionId]);
  const win = useStore((s) =>
    session ? s.windows[session.activeWindowId] : undefined,
  );
  const agent = useStore((s) =>
    session?.activeAgentId ? s.agents[session.activeAgentId] : undefined,
  );
  const zoomed = useStore((s) => s.zoomedPaneId != null);
  const leftOpen = useStore((s) => s.leftRailOpen);
  const rightOpen = useStore((s) => s.rightRailOpen);
  const [envOpen, setEnvOpen] = useState(false);

  if (!session || !win) return null;
  const isProject = session.kind === "project";

  // Env picker is project-session only — the Rundeck pane has its own
  // tree sub-rail for project + env-folder selection, so we don't
  // duplicate it up here.
  const envPicker = isProject
    ? {
        kind: "project" as const,
        active: session.env,
        options: ENVS.map((e) => ({ label: e, hint: null as string | null })),
        setActive: (label: string) => cmd.setEnv(label as (typeof ENVS)[number]),
      }
    : null;

  // Project-session deploy chip: maps session.env via the legacy alias
  // table to a Rundeck project name. Product-style sessions aren't wired
  // in here yet — they'd need an explicit per-session product binding.
  const deployTarget =
    isProject && session.cwd
      ? (() => {
          const svc = session.cwd.replace(/\/+$/, "").split("/").pop();
          if (!svc) return null;
          const project = legacyProjectForEnv(session.env);
          if (!project) return null;
          return { service: svc, envLabel: session.env, project };
        })()
      : null;

  return (
    <header className="top-bar" data-tauri-drag-region>
      <div className="tb-left" data-tauri-drag-region>
        <span className="brand-mark">
          <Logo size={17} />
        </span>
        <span className="brand-name">
          Sike<span className="brand-dim">mux</span>
        </span>
        <VersionChip />
        <UpdateChip />
      </div>

      <div className="tb-center" data-tauri-drag-region>
        <div className="crumb">
          <span className="crumb-kind">
            {isProject ? <IconFolder size={12} /> : <IconCommand size={12} />}
          </span>
          <span className="crumb-session">{session.name}</span>
          {isProject && (
            <>
              <IconChevron size={11} className="crumb-sep" />
              <span className="crumb-win">
                {session.view === "agent" ? (
                  agent?.title ?? "agent"
                ) : (
                  <>
                    <WindowIcon role={win.role} size={12} />
                    {win.name}
                  </>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="tb-right">
        {zoomed && (
          <span className="zoom-pill">
            <IconZoom size={11} />
            zoom
          </span>
        )}
        {envPicker && (
          <div className="env-dd">
            <button
              className="env-dd-btn"
              onClick={() => setEnvOpen((v) => !v)}
              title="Session environment"
            >
              <span className={`env-dot ${envPicker.active}`} />
              {envPicker.active}
              <IconChevron size={10} className="env-dd-chev" />
            </button>
            {envOpen && (
              <>
                <div className="env-dd-scrim" onClick={() => setEnvOpen(false)} />
                <div className="env-dd-menu">
                  {envPicker.options.map((opt) => (
                    <button
                      key={opt.label}
                      className={`env-dd-item${envPicker.active === opt.label ? " active" : ""}`}
                      onClick={() => {
                        envPicker.setActive(opt.label);
                        setEnvOpen(false);
                      }}
                    >
                      <span className={`env-dot ${opt.label}`} />
                      <span>{opt.label}</span>
                      {opt.hint && (
                        <span className="env-dd-item-proj">{opt.hint}</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {deployTarget && <DeployChip {...deployTarget} />}
        <AwsChip />
        <BatteryChip />
        <span className="tb-clock">
          {t.h}
          <span className="tb-colon">:</span>
          {time2(t.m)}
          <span className="tb-ampm">{t.ap}</span>
        </span>
        <div className="tb-toggles">
          <button
            className={`tb-btn${leftOpen ? " on" : ""}`}
            onClick={cmd.toggleLeftRail}
            title="Toggle sessions rail"
          >
            <IconPanelLeft size={15} />
          </button>
          <button
            className={`tb-btn${rightOpen ? " on" : ""}`}
            onClick={cmd.toggleRightRail}
            title="Toggle agents rail"
          >
            <IconPanelRight size={15} />
          </button>
          <button
            className="tb-btn"
            onClick={cmd.toggleSettings}
            title="Settings (⌘,)"
          >
            <CogIcon size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}
