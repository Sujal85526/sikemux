import { Calendar, isEmptyActivity, Overview, useActivitySummary } from "../components/ActivityPage";
import { AgentIcon } from "../components/Icons";
import { basename } from "../lib/paths";
import type { AgentType } from "../state/types";
import "../styles/activity.css";

export function ChatWelcome({ cwd, agentType }: { cwd: string; agentType: AgentType }) {
    const { summary, failed } = useActivitySummary(cwd);
    const totals = summary?.totals;
    return (
        <div className="chat-welcome">
            <div className="chat-welcome-head">
                <span className={`chat-welcome-mark agent-glyph ${agentType}`} aria-hidden="true">
                    <AgentIcon type={agentType} size={22} />
                </span>
                <span className="chat-welcome-title">{basename(cwd) || cwd}</span>
                <span className="chat-welcome-sub">Start a session with this project.</span>
            </div>
            {!failed && (
                <div className="chat-welcome-activity">
                    {!isEmptyActivity(totals) && <Overview totals={totals} />}
                    <Calendar days={summary?.days ?? []} loaded={!!summary} />
                </div>
            )}
        </div>
    );
}
