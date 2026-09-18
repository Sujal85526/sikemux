import { AGENT_STATE_META } from "../state/agentStatus";
import type { AgentPresentationState } from "../state/types";

const BACKGROUND_LABEL = "Shells or monitors still running";

/**
 * A spinner while an agent works, a dot once it has something waiting for you,
 * and nothing while it sits idle — a rail of idle agents would be a column of
 * dots carrying no information, since the row already says the agent exists.
 */
export function AgentStateIndicator({
    state,
    unread = false,
    background = false,
}: {
    state: AgentPresentationState;
    unread?: boolean;
    background?: boolean;
}) {
    if (state === "working") {
        const label = AGENT_STATE_META.working.label;
        return (
            <span className={`agent-activity state-working${unread ? " unread" : ""}`} title={label} aria-label={label} role="img">
                <span className="agent-state-loader" aria-hidden="true" />
            </span>
        );
    }
    const tone = state === "blocked" ? "blocked" : state === "done" ? "done" : background ? "background" : null;
    if (!tone) return null;
    const label = tone === "background" ? BACKGROUND_LABEL : AGENT_STATE_META[state].label;
    return (
        <span className={`agent-activity state-${tone}${unread ? " unread" : ""}`} title={label} aria-label={label} role="img">
            <span className="agent-state-dot" aria-hidden="true" />
        </span>
    );
}
