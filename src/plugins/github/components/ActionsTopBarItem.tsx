import type { PluginTopBarProps } from "../../../plugin-api";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { Tooltip } from "../../../plugin-api/ui";
import { useRepoOf } from "../project";
import { actionsRunsR, actionsStatusR } from "../resources";
import { formatAgo, isUnfinished, outcomeOf, OUTCOME_LABEL } from "../runStatus";
import { openRepo } from "../state";
import { OutcomeIcon } from "./ActionsIcon";
import { useEvery } from "./hooks";
import "../topbar.css";

const LIVE_REFRESH_MS = 10_000;
const IDLE_REFRESH_MS = 20_000;

/** How the branch in front is doing on CI, in the space of one glyph. */
export function ActionsTopBarItem({ projectCwd }: PluginTopBarProps) {
    const status = useResourceEnabled(!!projectCwd, actionsStatusR);
    const signedIn = !!status.data?.ok;
    const { repo, branch } = useRepoOf(projectCwd, signedIn);

    const runs = useResourceEnabled(signedIn && !!repo, actionsRunsR, {
        ...(repo ?? { owner: "", name: "" }),
        branch: branch ?? undefined,
        perPage: 1,
    });
    const latest = runs.data?.runs[0] ?? null;
    const live = !!latest && isUnfinished(latest);

    useEvery(signedIn && !!repo, live ? LIVE_REFRESH_MS : IDLE_REFRESH_MS, () => void runs.refresh());

    if (!repo || !latest) return null;

    const outcome = outcomeOf(latest);
    const label = `${OUTCOME_LABEL[outcome]} · ${latest.name} #${latest.runNumber} · ${formatAgo(latest.createdAt, Date.now())}`;
    return (
        <Tooltip label={label}>
            <button type="button" className="gha-topbar" data-outcome={outcome} onClick={() => openRepo(repo)} aria-label={label}>
                <OutcomeIcon outcome={outcome} size={12} />
                <span className="gha-topbar-number">#{latest.runNumber}</span>
            </button>
        </Tooltip>
    );
}
