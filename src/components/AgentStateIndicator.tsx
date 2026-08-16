import { AGENT_STATE_META } from "../state/agentStatus";
import type { AgentPresentationState } from "../state/types";

/**
 * A spinner while an agent is working, and nothing otherwise.
 *
 * Every other state used to render its own circle glyph, so a rail of idle
 * agents was a column of dots carrying no information — the row already says
 * the agent exists.
 */
export function AgentStateIndicator({ state, unread = false }: { state: AgentPresentationState; unread?: boolean }) {
    if (state !== "working") return null;
    const label = AGENT_STATE_META[state].label;
    return (
        <span className={`agent-activity state-working${unread ? " unread" : ""}`} title={label} aria-label={label} role="img">
            <span className="agent-state-loader" aria-hidden="true" />
        </span>
    );
}
