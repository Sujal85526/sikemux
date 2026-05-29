import { type RundeckStatus } from "../../api/rundeck";
import * as cmd from "../../state/commands";
import { useStore } from "../../state/store";
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
                            disabled={l.disabled || idx === labels.length - 1}>
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

interface Crumb {
    key: string;
    label: string;
    onClick: () => void;
    disabled?: boolean;
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

    if (top.kind === "service") {
        return [
            ...projectCrumbs(paneId, top.project, top.env),
            ...serviceCrumbs(paneId, top.service, top.env, {
                disabled: true,
            }),
        ];
    }

    if (top.kind === "deploy") {
        const serviceIndex = findPriorServiceIndex(stack, top.project, top.service);
        return [
            ...projectCrumbs(paneId, top.project, top.env),
            ...serviceCrumbs(paneId, top.service, top.env, {
                onClick: serviceIndex >= 0
                    ? () => cmd.rundeckPopTo(paneId, serviceIndex)
                    : () =>
                          cmd.rundeckReplace(paneId, {
                              kind: "service",
                              env: top.env,
                              project: top.project,
                              service: top.service,
                              jobId: top.jobId,
                              repoPath: top.repoPath,
                          }),
            }),
            {
                key: `deploy-${top.project}-${top.service}-${top.branch}`,
                label: "deploy",
                onClick: () => cmd.rundeckPopTo(paneId, stack.length - 1),
            },
        ];
    }

    const serviceIndex = findPriorServiceIndex(stack, top.project, top.service);
    const env = top.env ?? activeEnvFolder;
    return [
        ...projectCrumbs(paneId, top.project, env),
        ...serviceCrumbs(paneId, top.service, env, {
            disabled: serviceIndex < 0,
            onClick: serviceIndex >= 0 ? () => cmd.rundeckPopTo(paneId, serviceIndex) : undefined,
        }),
        {
            key: `execution-${top.executionId}`,
            label: `#${top.executionId}`,
            onClick: () => cmd.rundeckPopTo(paneId, stack.length - 1),
        },
    ];
}

function projectCrumbs(paneId: string, project: string, env: string | null | undefined): Crumb[] {
    if (!project) {
        return [{ key: "deployments", label: "deployments", onClick: () => cmd.rundeckHome(paneId) }];
    }
    const envFolder = env && env.toLowerCase() !== project.toLowerCase() ? env : null;
    return [
        { key: `project-${project}`, label: project, onClick: () => cmd.selectRundeckProject(paneId, project, null) },
        ...(envFolder
            ? [{ key: `env-${envFolder}`, label: envFolder, onClick: () => cmd.selectRundeckProject(paneId, project, envFolder) }]
            : []),
    ];
}

function serviceCrumbs(
    paneId: string,
    service: string,
    env: string | null | undefined,
    opts: { onClick?: () => void; disabled?: boolean },
): Crumb[] {
    const parts = service
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean);
    const normalized = env && parts[0] === env ? parts.slice(1) : parts;
    return normalized.map((label, i) => ({
        key: `svc-${i}-${label}`,
        label,
        onClick: opts.onClick ?? (() => cmd.rundeckHome(paneId)),
        disabled: opts.disabled,
    }));
}

function findPriorServiceIndex(stack: RundeckLevel[], project: string, service: string): number {
    for (let i = stack.length - 2; i >= 0; i -= 1) {
        const level = stack[i];
        if (level.kind === "service" && level.project === project && level.service === service) {
            return i;
        }
    }
    return -1;
}

function hostFromUrl(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}
