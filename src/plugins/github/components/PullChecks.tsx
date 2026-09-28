import { useResourceEnabled } from "../../../plugin-api/resources";
import type { RepoRef } from "../api";
import { actionsRunsR } from "../resources";
import { checksSummary, elapsedMs, formatDuration, isUnfinished, outcomeOf, OUTCOME_LABEL } from "../runStatus";
import { OutcomeIcon } from "./ActionsIcon";
import { useEvery, useNow } from "./hooks";

const LIVE_REFRESH_MS = 10_000;

interface Props {
    repo: RepoRef;
    sha: string;
    active: boolean;
    onOpenRun: (runId: number) => void;
}

export function PullChecks({ repo, sha, active, onOpenRun }: Props) {
    const found = useResourceEnabled(active, actionsRunsR, { ...repo, headSha: sha, perPage: 30 });
    const runs = found.data?.runs ?? [];
    const live = active && runs.some(isUnfinished);
    const now = useNow(live);
    useEvery(live, LIVE_REFRESH_MS, () => void found.refresh());
    if (runs.length === 0) return null;

    return (
        <div className="gha-checks">
            <div className="gha-section-label">
                Checks
                <span className="gha-dim">
                    {" · "}
                    {checksSummary(runs)}
                </span>
            </div>
            {runs.map((run) => {
                const outcome = outcomeOf(run);
                const going = isUnfinished(run);
                return (
                    <button key={run.id} type="button" className="gha-check" data-outcome={outcome} onClick={() => onOpenRun(run.id)}>
                        <OutcomeIcon outcome={outcome} />
                        <span className="gha-check-name">{run.name}</span>
                        <span className="gha-dim">{run.event}</span>
                        <span className="gha-check-spacer" />
                        <span className="gha-dim">{OUTCOME_LABEL[outcome]}</span>
                        <span className="gha-dim gha-mono">
                            {formatDuration(elapsedMs(run.startedAt ?? run.createdAt, going ? null : run.updatedAt, now))}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
