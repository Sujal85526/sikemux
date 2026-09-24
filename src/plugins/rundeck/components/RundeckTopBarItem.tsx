import { useMemo, useState } from "react";
import type { PluginTopBarProps } from "../../../plugin-api";
import { git, gitOverviewR, notify, reportError } from "../../../plugin-api/host";
import { invalidate, peekResource, useResourceEnabled } from "../../../plugin-api/resources";
import { IconChevron, IconGit, IconRundeck, Tooltip } from "../../../plugin-api/ui";
import type { RundeckEnvSpec } from "../api";
import { rndMatrixR, rndProjectsR } from "../resources";
import { envFolderOf } from "../shape";
import { openRundeckTarget, rundeckSettings, setDeployTarget } from "../state";
import { branchKind } from "./branchStyle";

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

function DeployChip({ loc, repo }: { loc: DeployLoc; repo: string }) {
    const k = branchKind(loc.branch);
    const repoStatus = useResourceEnabled(true, gitOverviewR, repo);
    const currentBranch = repoStatus.data?.status.branch.trim() ?? "";
    const [checkingOut, setCheckingOut] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const deployBranch = () => {
        openRundeckTarget(loc, repo, currentBranch);
        setMenuOpen(false);
    };
    const checkoutBranch = () => {
        if (!loc.branch || checkingOut) return;
        setCheckingOut(true);
        void git
            .checkoutSmart(repo, loc.branch)
            .then((msg) => {
                notify("success", msg);
                invalidate((kind, args) => (kind.startsWith("git.") || kind === "files.list") && args[0] === repo);
                setMenuOpen(false);
            })
            .catch(reportError("checkout deployed branch"))
            .finally(() => setCheckingOut(false));
    };
    return (
        <span className="tb-deploy-actions" data-no-window-drag>
            <Tooltip
                label={
                    loc.branch
                        ? `Rundeck actions: ${loc.status ?? "?"} · ${loc.branch} · ${loc.label}`
                        : `Rundeck actions for ${loc.service} on ${loc.label}`
                }>
                <button className="tb-deploy-chip" onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen}>
                    <IconRundeck size={12} />
                    {loc.branch && <span className={`tb-deploy-branch rnd-branch-${k}`}>{loc.branch}</span>}
                    <IconChevron size={10} className="env-dd-chev" />
                </button>
            </Tooltip>
            {menuOpen && (
                <>
                    <div className="env-dd-scrim" onClick={() => setMenuOpen(false)} />
                    <div className="env-dd-menu tb-deploy-menu" role="menu" aria-label="Rundeck actions">
                        <button
                            className="env-dd-item"
                            role="menuitem"
                            onClick={deployBranch}
                            disabled={repoStatus.status === "loading" && !currentBranch}>
                            <IconRundeck size={12} />
                            <span>{!currentBranch ? "deploy (loading branch…)" : "deploy"}</span>
                            {currentBranch && (
                                <span className={`tb-deploy-menu-branch rnd-branch-${branchKind(currentBranch)}`}>{currentBranch}</span>
                            )}
                        </button>
                        {loc.branch && (
                            <Tooltip
                                side="left"
                                label={`Checkout deployed branch ${loc.branch}. If it only exists on a remote, Sikemux will fetch and create a tracking local branch.`}>
                                <button className="env-dd-item" role="menuitem" onClick={checkoutBranch} disabled={checkingOut}>
                                    <IconGit size={12} />
                                    <span>{checkingOut ? "checking out…" : "checkout"}</span>
                                </button>
                            </Tooltip>
                        )}
                    </div>
                </>
            )}
        </span>
    );
}

/**
 * Where the project in front is deployed, and what is running there.
 *
 * Finding it takes two round trips to a deploy server that most projects have
 * nothing to do with, so it waits until something else has already asked
 * Rundeck for its projects, or the pointer moves over the strip it would show in.
 */
export function RundeckTopBarItem({ projectCwd, stripHovered }: PluginTopBarProps) {
    const [envOpen, setEnvOpen] = useState(false);
    const svc = projectCwd ? (projectCwd.replace(/\/+$/, "").split("/").pop() ?? null) : null;
    const deployWanted = stripHovered || peekResource(rndProjectsR) !== undefined;
    const rndProjects = useResourceEnabled(!!svc && deployWanted, rndProjectsR);
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

    const picked = rundeckSettings.useSelect((s) => (projectCwd ? s.deployTargets[projectCwd] : undefined));
    const activeLoc = locations.find((l) => picked && l.project === picked.project && l.folder === picked.folder) ?? locations[0] ?? null;
    if (!projectCwd || !activeLoc) return null;

    return (
        <>
            <div className="env-dd" data-no-window-drag>
                <button
                    className="env-dd-btn"
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={envOpen}
                    onClick={() => locations.length > 1 && setEnvOpen((v) => !v)}
                    aria-label={locations.length > 1 ? "Switch deploy location" : activeLoc.label}>
                    <span className={`env-dot ${envDotKind(activeLoc.folder)}`} />
                    <span className="env-dd-label">{activeLoc.label}</span>
                    {locations.length > 1 && <IconChevron size={10} className="env-dd-chev" />}
                </button>
                {envOpen && locations.length > 1 && (
                    <>
                        <div className="env-dd-scrim" onClick={() => setEnvOpen(false)} />
                        <div className="env-dd-menu" role="listbox" aria-label="Deploy location">
                            {locations.map((loc) => (
                                <button
                                    key={loc.label}
                                    className={`env-dd-item${activeLoc.label === loc.label ? " active" : ""}`}
                                    role="option"
                                    aria-selected={activeLoc.label === loc.label}
                                    onClick={() => {
                                        setDeployTarget(projectCwd, { project: loc.project, folder: loc.folder });
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
            <DeployChip loc={activeLoc} repo={projectCwd} />
            <span className="tb-sep" />
        </>
    );
}
