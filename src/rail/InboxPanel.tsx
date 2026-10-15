import { useState } from "react";
import { acpApi } from "../api/acp";
import { agentQuestionsApi } from "../api/agentQuestions";
import type { InboxItem } from "../api/inbox";
import { isAgentType } from "../agents/catalog";
import { AgentLabel } from "../agents/AgentLabel";
import { AgentStateIndicator } from "../agents/AgentStateIndicator";
import { basename } from "../lib/paths";
import { agentDisplay } from "../state/agentStatus";
import * as cmd from "../state/commands";
import { agentWindowId, ownerSessionId, projectSessionId } from "../state/selectors";
import { getState, useStore, type StoreState } from "../state/store";
import { reportError } from "../state/toast";
import { AgentIcon, IconFolder, IconTerminal } from "../ui/Icons";
import { Panel, PanelHeader } from "../ui/Panel";
import { dismissDigest, useInbox } from "./useInbox";

/** The project an item belongs to among those open: its agent's, else its folder's. */
export function itemSessionId(state: Pick<StoreState, "windows" | "sessionOrder" | "windowsBySession" | "sessions">, item: InboxItem): string | null {
    const windowId = item.agentId && agentWindowId(state, item.agentId);
    if (windowId) return ownerSessionId(state, windowId);
    const project = item.project ?? item.card?.project;
    return project ? projectSessionId(state, project) : null;
}

function showProject(item: InboxItem): void {
    const sessionId = itemSessionId(getState(), item);
    if (sessionId) cmd.selectSession(sessionId);
}

function openItem(item: InboxItem): void {
    const { agentId, url } = item;
    if (agentId && agentWindowId(getState(), agentId)) {
        cmd.revealAgent(agentId);
        if (item.kind === "pullRequest" && url) cmd.openUrlOnDesk(agentId, url);
        return;
    }
    showProject(item);
    if (item.card) cmd.openBoard();
}

/**
 * What waits on the person across every project, in the order the core ranks it; work under way is only counted. Above it,
 * once they come back, how many agents finished or failed while they were away.
 */
export function InboxPanel() {
    const { inbox, digest } = useInbox();
    const items = inbox.items.filter((item) => item.tier !== "progress");
    return (
        <>
            {digest && (
                <Panel variant="group" className="agent-group">
                    <PanelHeader
                        label="While you were away"
                        rule
                        extra={<span className="inbox-count">{`${digest.finished.length} finished · ${digest.failed.length} failed`}</span>}
                        actions={[{ label: "Dismiss", onClick: dismissDigest }]}
                    />
                </Panel>
            )}
            {items.length > 0 && (
                <Panel variant="group" className={`agent-group${items[0].tier === "needs" ? " agent-attention" : ""}`}>
                    <PanelHeader
                        label={`Inbox ${items.length}`}
                        rule
                        extra={inbox.working > 0 && <span className="inbox-count">{inbox.working} working</span>}
                    />
                    {items.map((item) => (
                        <InboxRow key={item.id} item={item} />
                    ))}
                </Panel>
            )}
        </>
    );
}

function InboxRow({ item }: { item: InboxItem }) {
    const elsewhere = useStore((s) => itemSessionId(s, item) !== s.activeSessionId);
    const { cli, project, tier } = item;
    const why = item.detail ? `${item.what}: ${item.detail}` : item.what;
    return (
        <div className="agent-row-wrap">
            <button className="agent-row two-line" title={why} onClick={() => openItem(item)}>
                <span className={`agent-glyph ${cli}`}>{isAgentType(cli) ? <AgentIcon type={cli} size={20} /> : <IconTerminal size={16} />}</span>
                <span className="agent-row-text">
                    <span className="agent-title">
                        <AgentLabel
                            agent={{
                                name: item.name && item.host ? `${item.name} on ${item.host}` : (item.name ?? undefined),
                                title: item.title ?? item.card?.title ?? "",
                            }}
                        />
                    </span>
                    <span className="agent-row-project">
                        <span className={`inbox-why${item.kind === "failed" ? " failed" : ""}`}>{why}</span>
                        {elsewhere && project && (
                            <>
                                <IconFolder size={11} />
                                <span className="inbox-project">{basename(project)}</span>
                            </>
                        )}
                    </span>
                </span>
            </button>
            <span className="row-status">
                <AgentStateIndicator display={agentDisplay(tier === "needs" ? "blocked" : "done")} />
            </span>
            {tier === "needs" && <InboxAnswers item={item} />}
        </div>
    );
}

/** The answers a permission or question takes in one click; anything longer is written in the chat. */
function InboxAnswers({ item: { agentId, requestId, choices, questionId, kind } }: { item: InboxItem }) {
    const question = useStore((s) => s.agentQuestions.find((asked) => asked.id === questionId));
    const [busy, setBusy] = useState(false);
    const answers: [string, () => Promise<unknown>][] = [];
    if (agentId && requestId && choices) {
        for (const [label, option] of [
            ["Allow", choices.allowOnce],
            ["Always allow", choices.allowAlways],
            ["Deny", choices.reject],
        ] as const)
            if (option) answers.push([label, () => acpApi.permissionReply(agentId, requestId, option)]);
    }
    if (question) {
        question.choices.forEach((choice, index) => answers.push([choice.label, () => agentQuestionsApi.answer(question.id, { choice: index })]));
        if (kind === "assumption") answers.push(["Fine", () => agentQuestionsApi.answer(question.id, { fine: true })]);
    }
    return (
        answers.length > 0 && (
            <div className="inbox-answers">
                {answers.map(([label, send]) => (
                    <button
                        key={label}
                        type="button"
                        className="panel-abtn"
                        disabled={busy}
                        onClick={() => {
                            setBusy(true);
                            send()
                                .catch(reportError("Could not answer"))
                                .finally(() => setBusy(false));
                        }}>
                        {label}
                    </button>
                ))}
            </div>
        )
    );
}
