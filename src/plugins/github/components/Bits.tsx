import type { CSSProperties, ReactNode } from "react";
import { openUrl, swallow } from "../../../plugin-api/host";
import { IconCheck, IconChevron, IconExternal, IconGit, IconMerge, IconPullRequest } from "../../../plugin-api/ui";
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

function toneOf(kind: "pull" | "issue", state: string, draft: boolean, reason: string | null): string {
    return kind === "issue" && state === "closed" && reason === "not_planned" ? "not_planned" : stateOf(state, draft);
}

export function stateLabel(kind: "pull" | "issue", state: string, draft = false, reason: string | null = null): string {
    const tone = toneOf(kind, state, draft, reason);
    return (kind === "pull" ? PULL_LABEL : ISSUE_LABEL)[tone] ?? tone;
}

export function StateMark({
    kind,
    state,
    draft = false,
    reason = null,
    size = 12,
}: {
    kind: "pull" | "issue";
    state: string;
    draft?: boolean;
    reason?: string | null;
    size?: number;
}) {
    const tone = toneOf(kind, state, draft, reason);
    const label = stateLabel(kind, state, draft, reason);
    return (
        <span className="gha-state-mark" data-kind={kind} data-state={tone} title={label} aria-label={label} role="img">
            <StateGlyph kind={kind} tone={tone} size={size} />
        </span>
    );
}

function StateGlyph({ kind, tone, size }: { kind: "pull" | "issue"; tone: string; size: number }) {
    if (kind === "pull") return tone === "merged" ? <IconMerge size={size} /> : <IconPullRequest size={size} />;
    if (tone === "not_planned") return <NotPlannedIcon size={size} />;
    return tone === "closed" ? <IconCheck size={size} /> : <SectionIcon section="issues" size={size} />;
}

export function PageHead({
    mark,
    title,
    number,
    url,
    backLabel,
    onBack,
    children,
}: {
    mark: ReactNode;
    title: string;
    number: number;
    url: string;
    backLabel: string;
    onBack: () => void;
    children: ReactNode;
}) {
    return (
        <>
            <button type="button" className="gha-back" onClick={onBack}>
                <IconChevron size={11} /> {backLabel}
            </button>
            <div className="gha-page-head">
                {mark}
                <div className="gha-page-title">
                    <h2 className="gha-title">{title}</h2>
                    <span className="gha-page-number">#{number}</span>
                    <span className="gha-page-spacer" />
                    <button type="button" className="gha-btn" onClick={() => void openUrl(url).catch(swallow("open GitHub"))}>
                        <IconExternal size={12} /> On GitHub
                    </button>
                </div>
                <div className="gha-page-sub">{children}</div>
            </div>
        </>
    );
}
