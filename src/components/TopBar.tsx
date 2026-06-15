import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { installPendingUpdate } from "../api/updater";
import { useBattery } from "../hooks/useBattery";
import { useClock } from "../hooks/useClock";
import type { RundeckEnvSpec } from "../api/rundeck";
import * as cmd from "../state/commands";
import { useResource, useResourceEnabled } from "../state/resources";
import { swallow } from "../state/toast";
import { awsIdentityR, gitStatusR, rndMatrixR, rndProjectsR } from "../state/resources.defs";
import { envFolderOf } from "../state/rundeckShape";
import { useStore } from "../state/store";
import {
    IconAws,
    IconBattery,
    IconChevron,
    IconCommand,
    IconFocus,
    IconFolder,
    IconGit,
    IconPanelLeft,
    IconPanelRight,
    IconRundeck,
    IconZoom,
    WindowIcon,
} from "./Icons";
import { useMemo } from "react";
import { branchKind } from "./rundeck/branchStyle";

const time2 = (n: number) => String(n).padStart(2, "0");

function twelveHour(d: Date): { h: number; m: number; ap: "am" | "pm" } {
    const h24 = d.getHours();
    const h = h24 % 12 || 12;
    return { h, m: d.getMinutes(), ap: h24 >= 12 ? "pm" : "am" };
}

function AwsChip() {
    const profile = useStore((s) => s.awsProfile);
    const identity = useResourceEnabled(!!profile, awsIdentityR, profile ?? "", false);
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

    const title = profile ? `AWS · ${profile}${status ? ` · ${status}` : ""}` : "AWS — sign in";

    return (
        <button className={`tb-aws-chip ${dotClass}`} onClick={onClick} title={title}>
            <IconAws size={24} />
        </button>
    );
}

/** A Rundeck deploy location for the current service: where it lives + its last deploy. */
interface DeployLoc {
    project: string;
    folder: string | null;
    label: string;
    service: string;
    jobId: string;
    branch: string | null;
    status: string | null;
    group: string | null;
}

function envDotKind(name: string | null): string {
    const e = (name ?? "").toLowerCase();
    if (e.startsWith("prod")) return "production";
    if (e.startsWith("stag")) return "staging";
    if (e.startsWith("pre")) return "preprod";
    if (e.startsWith("dev")) return "dev";
    return "other";
}

function DeployChip({ loc }: { loc: DeployLoc }) {
    const k = branchKind(loc.branch);
    const onClick = () => {
        cmd.openRundeckService({ project: loc.project, service: loc.service, jobId: loc.jobId, group: loc.group });
    };
    return (
        <button
            className="tb-deploy-chip"
            onClick={onClick}
            title={
                loc.branch
                    ? `Last deploy: ${loc.status ?? "?"} · ${loc.branch} · ${loc.label}`
                    : `No deploy history for ${loc.service} on ${loc.label}`
            }>
            <IconRundeck size={12} />
            {loc.branch && <span className={`tb-deploy-branch rnd-branch-${k}`}>{loc.branch}</span>}
        </button>
    );
}

function GitChip({ repo }: { repo: string }) {
    const res = useResource(gitStatusR, repo);
    const st = res.data;
    if (!st) return null;

    const dirty = st.files.length > 0;
    const ahead = st.ahead;
    const behind = st.behind;
    const title = `${st.branch}${st.upstream ? ` → ${st.upstream}` : ""}${dirty ? ` · ${st.files.length} changed` : " · clean"}${ahead ? ` · ahead ${ahead}` : ""}${behind ? ` · behind ${behind}` : ""}`;

    return (
        <>
            <button className="tb-git-chip" onClick={cmd.openGitPane} title={title}>
                <IconGit size={12} className={`tb-git-ico ${dirty ? "dirty" : "clean"}`} />
                <span className="tb-git-branch">{st.branch}</span>
                {(ahead > 0 || behind > 0) && (
                    <span className="tb-git-track">
                        {ahead > 0 && <span className="tb-git-ahead">↑{ahead}</span>}
                        {behind > 0 && <span className="tb-git-behind">↓{behind}</span>}
                    </span>
                )}
            </button>
            <span className="tb-sep" />
        </>
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
            strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    );
}

export function VersionChip() {
    const [version, setVersion] = useState<string | null>(null);
    useEffect(() => {
        getVersion().then(setVersion).catch(swallow("getVersion"));
    }, []);
    if (!version) return null;
    return (
        <span className="tb-version" title={`Sikemux ${version}`}>
            v{version}
        </span>
    );
}

export function UpdateChip() {
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
            }>
            <UpdateArrow size={12} />
            <span className="tb-update-label">
                {state === "installing" ? "installing…" : state === "error" ? "update failed — retry" : `update · v${pending.version}`}
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
            aria-hidden="true">
            <path d="M8 2v9M4 7l4 4 4-4M3 14h10" />
        </svg>
    );
}

function BatteryChip() {
    const batt = useBattery();
    if (!batt || batt.percent == null) return null;
    const pct = batt.percent;
    const tone = pct <= 10 ? "danger" : pct <= 20 ? "warn" : "ok";
    return (
        <span
            className={`tb-batt tb-batt-${tone}${batt.charging ? " charging" : ""}`}
            title={batt.time_remaining ? `${pct}% · ${batt.time_remaining} remaining` : `${pct}%${batt.charging ? " · charging" : ""}`}>
            <IconBattery size={11} percent={pct} charging={batt.charging} />
            <span className="tb-batt-pct">{pct}%</span>
        </span>
    );
}

export function TopBar() {
    const now = useClock();
    const t = twelveHour(now);
    const session = useStore((s) => s.sessions[s.activeSessionId]);
    const win = useStore((s) => (session ? s.windows[session.activeWindowId] : undefined));
    const agent = useStore((s) => (session?.activeAgentId ? s.agents[session.activeAgentId] : undefined));
    const zoomed = useStore((s) => s.zoomedPaneId != null);
    const leftOpen = useStore((s) => s.leftRailOpen);
    const rightOpen = useStore((s) => s.rightRailOpen);
    const zen = useStore((s) => s.zenMode);
    const [envOpen, setEnvOpen] = useState(false);

    const isProject = !!session && session.kind === "project";
    const svc = isProject && session!.cwd ? (session!.cwd.replace(/\/+$/, "").split("/").pop() ?? null) : null;

    // Find every Rundeck project/sub-folder where this service is deployed, so the
    // picker can offer e.g. "channeliq/production" instead of a static env list.
    const rndProjects = useResourceEnabled(!!svc, rndProjectsR);
    const specs = useMemo<RundeckEnvSpec[]>(
        () => (rndProjects.data ?? []).map((p) => ({ label: p.name, project: p.name, only_succeeded: true })),
        [rndProjects.data],
    );
    const matrix = useResourceEnabled(!!svc && specs.length > 0, rndMatrixR, specs);
    const locations = useMemo<DeployLoc[]>(() => {
        if (!svc) return [];
        const out: DeployLoc[] = [];
        const seen = new Set<string>();
        for (const env of matrix.data?.envs ?? []) {
            for (const cell of env.cells) {
                if (cell.name !== svc && cell.service !== svc && !cell.service.endsWith(`/${svc}`)) continue;
                const folder = envFolderOf(cell.group);
                const key = `${env.project}/${folder ?? ""}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    project: env.project,
                    folder,
                    label: folder ? `${env.project}/${folder}` : env.project,
                    service: cell.service,
                    jobId: cell.job_id,
                    branch: cell.branch,
                    status: cell.status,
                    group: cell.group,
                });
            }
        }
        out.sort((a, b) => a.label.localeCompare(b.label));
        return out;
    }, [matrix.data, svc]);

    const picked = session?.deploy;
    const activeLoc = locations.find((l) => picked && l.project === picked.project && l.folder === picked.folder) ?? locations[0] ?? null;

    if (!session || !win) return null;

    return (
        <header className="top-bar" data-tauri-drag-region>
            <div className="tb-left" data-tauri-drag-region />

            <div className="tb-center" data-tauri-drag-region>
                <div className="crumb">
                    <span className="crumb-kind">{isProject ? <IconFolder size={12} /> : <IconCommand size={12} />}</span>
                    <span className="crumb-session">{session.name}</span>
                    {isProject && (
                        <>
                            <IconChevron size={11} className="crumb-sep" />
                            <span className="crumb-win">
                                {session.view === "agent" ? (
                                    <span className="crumb-name">{agent?.title ?? "agent"}</span>
                                ) : (
                                    <>
                                        <WindowIcon role={win.role} size={12} />
                                        <span className="crumb-name">{win.name}</span>
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
                {isProject && session.cwd && !(session.view === "windows" && win.role === "git") && <GitChip repo={session.cwd} />}
                {activeLoc && (
                    <div className="env-dd">
                        <button
                            className="env-dd-btn"
                            onClick={() => locations.length > 1 && setEnvOpen((v) => !v)}
                            title={locations.length > 1 ? "Switch deploy location" : activeLoc.label}>
                            <span className={`env-dot ${envDotKind(activeLoc.folder)}`} />
                            {activeLoc.label}
                            {locations.length > 1 && <IconChevron size={10} className="env-dd-chev" />}
                        </button>
                        {envOpen && locations.length > 1 && (
                            <>
                                <div className="env-dd-scrim" onClick={() => setEnvOpen(false)} />
                                <div className="env-dd-menu">
                                    {locations.map((loc) => (
                                        <button
                                            key={loc.label}
                                            className={`env-dd-item${activeLoc.label === loc.label ? " active" : ""}`}
                                            onClick={() => {
                                                cmd.setDeployTarget({ project: loc.project, folder: loc.folder });
                                                setEnvOpen(false);
                                            }}>
                                            <span className={`env-dot ${envDotKind(loc.folder)}`} />
                                            <span>{loc.label}</span>
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                )}
                {activeLoc && <DeployChip loc={activeLoc} />}
                <span className="tb-sep" />
                <AwsChip />
                <BatteryChip />
                <span className="tb-clock">
                    {t.h}
                    <span className="tb-colon">:</span>
                    {time2(t.m)}
                    <span className="tb-ampm">{t.ap}</span>
                </span>
                <div className="tb-toggles">
                    <button className={`tb-btn${zen ? " on" : ""}`} onClick={cmd.toggleZen} title="Focus mode — hide rails">
                        <IconFocus size={15} />
                    </button>
                    <button className={`tb-btn${leftOpen ? " on" : ""}`} onClick={cmd.toggleLeftRail} title="Toggle sessions rail">
                        <IconPanelLeft size={15} />
                    </button>
                    <button className={`tb-btn${rightOpen ? " on" : ""}`} onClick={cmd.toggleRightRail} title="Toggle agents rail">
                        <IconPanelRight size={15} />
                    </button>
                    <button className="tb-btn" onClick={cmd.toggleSettings} title="Settings — ⌘,">
                        <CogIcon size={15} />
                    </button>
                </div>
            </div>
        </header>
    );
}
