import { useEffect } from "react";
import type { PluginTopBarProps } from "../../../plugin-api";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { Tooltip } from "../../../plugin-api/ui";
import { remoteRepoR } from "../project";
import { actionsRunsR, actionsStatusR } from "../resources";
import { formatAgo, isRunning, outcomeOf, OUTCOME_LABEL } from "../runStatus";
import { actionsSettings, openRepo, refOf } from "../state";
import { OutcomeIcon } from "./ActionsIcon";
import "../topbar.css";

const LIVE_REFRESH_MS = 15_000;

/** How the branch in front is doing on CI, in the space of one glyph. */
export function ActionsTopBarItem({ projectCwd }: PluginTopBarProps) {
    const status = useResourceEnabled(!!projectCwd, actionsStatusR);
    const signedIn = !!status.data?.ok;
    const chosen = actionsSettings.useSelect((settings) => (projectCwd ? (settings.repoByProject[projectCwd] ?? null) : null));
    const overridden = chosen ? refOf(chosen) : null;
    const fromRemote = useResourceEnabled(signedIn && !!projectCwd && !overridden, remoteRepoR, projectCwd ?? "");
    const repo = overridden ?? fromRemote.data ?? null;

    const runs = useResourceEnabled(signedIn && !!repo, actionsRunsR, { ...(repo ?? { owner: "", name: "" }), perPage: 1 });
    const latest = runs.data?.runs[0] ?? null;
    const live = !!latest && isRunning(latest);

    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => void runs.refresh(), LIVE_REFRESH_MS);
        return () => clearInterval(timer);
    }, [live, runs]);

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
