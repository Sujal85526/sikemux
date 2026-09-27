import { useResourceEnabled } from "../../../plugin-api/resources";
import type { Billable, RepoRef } from "../api";
import { actionsTimingR } from "../resources";
import { formatDuration } from "../runStatus";

/** Runner minutes, the unit GitHub bills and reports them in. */
export function billedMinutes(billable: readonly Billable[]): number {
    return billable.reduce((total, each) => total + Math.ceil(each.totalMs / 60_000), 0);
}

interface Props {
    repo: RepoRef;
    runId: number;
    active: boolean;
}

/**
 * What the run took on the clock, and what it is billed for. A public
 * repository is free and reports nothing billable, so nothing is shown.
 */
export function RunUsage({ repo, runId, active }: Props) {
    const timing = useResourceEnabled(active, actionsTimingR, repo, runId);
    const found = timing.data;
    if (!found) return null;
    const minutes = billedMinutes(found.billable);
    return (
        <span className="gha-usage">
            {found.runDurationMs !== null && (
                <span>
                    took <span className="gha-usage-value">{formatDuration(found.runDurationMs)}</span>
                </span>
            )}
            {minutes > 0 && (
                <span title={found.billable.map((each) => `${each.runner}: ${formatDuration(each.totalMs)} over ${each.jobs} jobs`).join("\n")}>
                    billed <span className="gha-usage-value">{minutes} min</span>
                </span>
            )}
        </span>
    );
}
