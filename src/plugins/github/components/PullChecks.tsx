import { useResourceEnabled } from "../../../plugin-api/resources";
import type { RepoRef } from "../api";
import { actionsRunsR } from "../resources";
import { elapsedMs, formatDuration, isUnfinished, outcomeOf, OUTCOME_LABEL } from "../runStatus";
import { OutcomeIcon } from "./ActionsIcon";

interface Props {
    repo: RepoRef;
    sha: string;
    active: boolean;
    now: number;
    onOpenRun: (runId: number) => void;
}

/** The workflow runs on a pull request's latest commit, each one a click from its jobs and logs. */
export function PullChecks({ repo, sha, active, now, onOpenRun }: Props) {
    const found = useResourceEnabled(active, actionsRunsR, { ...repo, headSha: sha, perPage: 30 });
    const runs = found.data?.runs ?? [];
    if (runs.length === 0) return null;
    const failed = runs.filter((run) => outcomeOf(run) === "failure").length;
    const going = runs.filter(isUnfinished).length;

    return (
        <div className="gha-checks">
            <div className="gha-section-label">
                Checks
                <span className="gha-dim">
                    {" · "}
                    {failed > 0 ? `${failed} failing` : going > 0 ? `${going} running` : "all passed"}
                </span>
            </div>
            {runs.map((run) => {
                const outcome = outcomeOf(run);
                const live = isUnfinished(run);
                return (
                    <button key={run.id} type="button" className="gha-check" data-outcome={outcome} onClick={() => onOpenRun(run.id)}>
                        <OutcomeIcon outcome={outcome} />
                        <span className="gha-check-name">{run.name}</span>
                        <span className="gha-dim">{run.event}</span>
                        <span className="gha-check-spacer" />
                        <span className="gha-dim">{OUTCOME_LABEL[outcome]}</span>
                        <span className="gha-dim gha-mono">
                            {formatDuration(elapsedMs(run.startedAt ?? run.createdAt, live ? null : run.updatedAt, now))}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
