import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { PRIMARY_SHORTCUT } from "../../lib/platform";
import { setGitDraft, useGitWorkbench } from "../../state/gitWorkbench";
import { IconChevron, IconSparkle } from "../Icons";
import { Tooltip } from "../Tooltip";

/** The draft is one string; its first line is the summary and the rest, after a blank line, the description. */
export function splitDraft(draft: string): { summary: string; description: string } {
    const newline = draft.indexOf("\n");
    if (newline === -1) return { summary: draft, description: "" };
    return { summary: draft.slice(0, newline), description: draft.slice(newline + 1).replace(/^\n/, "") };
}

export function joinDraft(summary: string, description: string): string {
    return description ? `${summary}\n\n${description}` : summary;
}

export function GitComposer({
    repo,
    busy,
    generating,
    stagedCount,
    agentLabel,
    summaryRef,
    onCommit,
    onGenerate,
    onPickAgent,
}: {
    repo: string;
    busy: boolean;
    generating: boolean;
    stagedCount: number;
    agentLabel: string;
    summaryRef: RefObject<HTMLTextAreaElement | null>;
    onCommit: () => void;
    onGenerate: () => void;
    onPickAgent: (anchor: HTMLElement) => void;
}) {
    const draft = useGitWorkbench((state) => state.drafts[repo] ?? "");
    const { summary, description } = splitDraft(draft);
    const descriptionRef = useRef<HTMLTextAreaElement>(null);
    const canCommit = !busy && stagedCount > 0 && !!summary.trim();

    // A long summary wraps rather than scrolling out of sight, so the box grows with it.
    useLayoutEffect(() => {
        const el = summaryRef.current;
        if (!el) return;
        const fit = () => {
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
        };
        fit();
        // Widening the column can unwrap the summary, so its height follows the width too.
        let width = el.clientWidth;
        const observer = new ResizeObserver(() => {
            if (el.clientWidth === width) return;
            width = el.clientWidth;
            fit();
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [summary, summaryRef]);
    const commitLabel = stagedCount > 0 ? `Commit ${stagedCount} file${stagedCount === 1 ? "" : "s"}` : "Commit";

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        event.stopPropagation();
        if (busy) {
            event.preventDefault();
            return;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (canCommit) onCommit();
        } else if (event.key === "Escape") event.currentTarget.blur();
    };

    return (
        <div className="git-compose">
            <div className="git-compose-well">
                <textarea
                    ref={summaryRef}
                    className="git-compose-summary"
                    placeholder="Summary"
                    aria-label="Commit summary"
                    value={summary}
                    rows={1}
                    spellCheck={false}
                    readOnly={busy}
                    onChange={(event) => setGitDraft(repo, joinDraft(event.target.value.replace(/\n/g, " "), description))}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                            event.preventDefault();
                            event.stopPropagation();
                            descriptionRef.current?.focus();
                            return;
                        }
                        onKeyDown(event);
                    }}
                />
                <textarea
                    ref={descriptionRef}
                    className="git-compose-description"
                    placeholder="Description"
                    aria-label="Commit description"
                    value={description}
                    rows={3}
                    spellCheck={false}
                    readOnly={busy}
                    onChange={(event) => setGitDraft(repo, joinDraft(summary, event.target.value))}
                    onKeyDown={onKeyDown}
                />
                <div className="git-compose-foot">
                    <Tooltip label="Write the message from the staged changes (g)">
                        <button type="button" className="git-compose-agent" disabled={busy} onClick={onGenerate}>
                            <span className={`git-compose-spark${generating ? " writing" : ""}`}>
                                <IconSparkle size={11} />
                            </span>
                            <span>{generating ? "writing…" : agentLabel}</span>
                        </button>
                    </Tooltip>
                    <Tooltip label="Pick the agent and model">
                        <button
                            type="button"
                            className="git-compose-agent-pick"
                            aria-label="Pick the agent and model"
                            onClick={(event) => onPickAgent(event.currentTarget)}>
                            <IconChevron size={9} />
                        </button>
                    </Tooltip>
                    <Tooltip label={stagedCount > 0 ? `${commitLabel} (${PRIMARY_SHORTCUT}⏎)` : "Stage files to commit them"}>
                        <button type="button" className="git-compose-commit" disabled={!canCommit} onClick={onCommit}>
                            {commitLabel}
                        </button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}
