import { type RundeckStatus } from "../../api/rundeck";
import * as cmd from "../../state/commands";
import { getState, useStore } from "../../state/store";
import type { RundeckLevel } from "../../state/types";
import { IconChevron } from "../Icons";

interface Props {
    paneId: string;
    status: RundeckStatus | null;
}

/** Top bar: chevron breadcrumb of the nav stack + env picker on the right.
 *  No logout — invalid tokens auto-redirect via the rnd-auth-expired bus. */
export function RundeckBreadcrumb({ paneId, status }: Props) {
    const view = useStore((s) => s.rundeckViews[paneId]);
    const activeProject = useStore((s) => s.rundeck.activeProject);
    const activeEnvFolder = useStore((s) => s.rundeck.activeEnvFolder);
    const stack = view?.stack ?? [{ kind: "matrix" as const }];

    const labels = breadcrumbLabels(paneId, stack, activeProject, activeEnvFolder);

    return (
        <div className="rnd-bar">
            <button className="rnd-bar-back" title="Back" disabled={stack.length <= 1} onClick={() => cmd.rundeckPop(paneId)}>
                <span style={{ transform: "rotate(90deg)", display: "inline-flex" }}>
                    <IconChevron size={11} />
                </span>
            </button>
            <div className="rnd-bar-trail">
                {labels.map((l, idx) => (
                    <span key={l.key} className="rnd-crumb-row">
                        {idx > 0 && (
                            <span className="rnd-crumb-sep">
                                <IconChevron size={9} />
                            </span>
                        )}
                        <button
                            className={`rnd-crumb${idx === labels.length - 1 ? " current" : ""}`}
                            onClick={l.onClick}
                            disabled={idx === labels.length - 1}>
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
            </div>
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

interface Crumb {
    key: string;
    label: string;
    onClick: () => void;
}

function breadcrumbLabels(
    paneId: string,
    stack: RundeckLevel[],
    activeProject: string,
    activeEnvFolder: string | null,
): Crumb[] {
    const top = stack[stack.length - 1];
    if (!top || top.kind === "matrix") {
        return projectCrumbs(paneId, activeProject, activeEnvFolder);
    }

    if (top.kind === "service" || top.kind === "deploy") {
        return [
            ...projectCrumbs(paneId, top.project, top.env),
            ...serviceCrumbs(paneId, stack.length - 1, top.service, top.env),
        ];
    }

    return [
        ...projectCrumbs(paneId, top.project, activeEnvFolder),
        ...serviceCrumbs(paneId, stack.length - 1, top.service, activeEnvFolder ?? undefined),
        {
            key: `execution-${top.executionId}`,
            label: `#${top.executionId}`,
            onClick: () => popTo(paneId, stack.length - 1),
        },
    ];
}

function projectCrumbs(paneId: string, project: string, env: string | null | undefined): Crumb[] {
    if (!project) {
        return [{ key: "deployments", label: "deployments", onClick: () => cmd.rundeckHome(paneId) }];
    }
    return [
        { key: `project-${project}`, label: project, onClick: () => cmd.rundeckHome(paneId) },
        ...(env ? [{ key: `env-${env}`, label: env, onClick: () => cmd.rundeckHome(paneId) }] : []),
    ];
}

function serviceCrumbs(paneId: string, stackIndex: number, service: string, env?: string | null): Crumb[] {
    const parts = service
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean);
    const normalized = env && parts[0] === env ? parts.slice(1) : parts;
    return normalized.map((label, i) => ({
        key: `svc-${stackIndex}-${i}-${label}`,
        label,
        onClick: () => popTo(paneId, stackIndex),
    }));
}

function hostFromUrl(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}
