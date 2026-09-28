import type { CSSProperties } from "react";
import { IconCheck, IconGit, IconMerge, IconPullRequest } from "../../../plugin-api/ui";
import type { Label } from "../api";
import { CommentIcon, NotPlannedIcon, SectionIcon } from "./ActionsIcon";

const HEX = /^[0-9a-f]{6}$/iu;

export function Labels({ labels }: { labels: readonly Label[] }) {
    if (labels.length === 0) return null;
    return (
        <span className="gha-labels">
            {labels.map((label) => (
                <span
                    key={label.name}
                    className="gha-label"
                    title={label.name}
                    style={HEX.test(label.color) ? ({ "--label": `#${label.color}` } as CSSProperties) : undefined}>
                    {label.name}
                </span>
            ))}
        </span>
    );
}

export function Branch({ name }: { name: string }) {
    return (
        <span className="gha-branch" title={name}>
            <IconGit size={11} />
            <span>{name}</span>
        </span>
    );
}

export function Comments({ count }: { count: number }) {
    if (count === 0) return null;
    return (
        <span className="gha-item-comments" title={`${count} comment${count === 1 ? "" : "s"}`}>
            <CommentIcon />
            {count}
        </span>
    );
}

const PULL_LABEL: Record<string, string> = { open: "Open", closed: "Closed", merged: "Merged", draft: "Draft" };
const ISSUE_LABEL: Record<string, string> = { open: "Open", closed: "Closed", not_planned: "Closed as not planned" };

/** A draft is still open, but it reads as its own state the way GitHub shows it. */
export function stateOf(state: string, draft: boolean): string {
    return draft && state === "open" ? "draft" : state;
}

export function StateMark({
    kind,
    state,
    draft = false,
    reason = null,
}: {
    kind: "pull" | "issue";
    state: string;
    draft?: boolean;
    reason?: string | null;
}) {
    const tone = kind === "issue" && state === "closed" && reason === "not_planned" ? "not_planned" : stateOf(state, draft);
    const label = (kind === "pull" ? PULL_LABEL : ISSUE_LABEL)[tone] ?? tone;
    return (
        <span className="gha-state-mark" data-kind={kind} data-state={tone} title={label} aria-label={label} role="img">
            <StateGlyph kind={kind} tone={tone} />
        </span>
    );
}

function StateGlyph({ kind, tone }: { kind: "pull" | "issue"; tone: string }) {
    if (kind === "pull") return tone === "merged" ? <IconMerge size={12} /> : <IconPullRequest size={12} />;
    if (tone === "not_planned") return <NotPlannedIcon size={12} />;
    return tone === "closed" ? <IconCheck size={12} /> : <SectionIcon section="issues" size={12} />;
}
