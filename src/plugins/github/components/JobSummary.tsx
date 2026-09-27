import { useResourceEnabled } from "../../../plugin-api/resources";
import { Markdown } from "../../../plugin-api/ui";
import type { RepoRef } from "../api";
import { actionsJobSummaryR } from "../resources";

interface Props {
    repo: RepoRef;
    checkRunId: number;
    active: boolean;
    jobName: string;
}

/**
 * What a job wrote to `$GITHUB_STEP_SUMMARY` — a test report, a coverage
 * table — which is the part of a run somebody means to read rather than the
 * log it would otherwise be buried in.
 */
export function JobSummary({ repo, checkRunId, active, jobName }: Props) {
    const found = useResourceEnabled(active, actionsJobSummaryR, repo, checkRunId);
    const summary = found.data;
    if (!summary) return null;
    return (
        <details className="gha-summary" open>
            <summary className="gha-summary-head">{jobName} summary</summary>
            <Markdown className="gha-prose">{summary.body}</Markdown>
        </details>
    );
}
