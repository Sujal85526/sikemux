import { IconCheck, IconClose, IconPullRequest } from "../../../plugin-api/ui";
import type { Label } from "../api";

export function Labels({ labels }: { labels: readonly Label[] }) {
    if (labels.length === 0) return null;
    return (
        <>
            {labels.map((label) => (
                <span key={label.name} className="gha-label" title={label.name}>
                    {label.name}
                </span>
            ))}
        </>
    );
}

const PULL_LABEL: Record<string, string> = { open: "Open", closed: "Closed", merged: "Merged", draft: "Draft" };
const ISSUE_LABEL: Record<string, string> = { open: "Open", closed: "Closed" };

/** A draft is still open, but it reads as its own state the way GitHub shows it. */
export function stateOf(state: string, draft: boolean): string {
    return draft && state === "open" ? "draft" : state;
}

/**
 * Where a pull request or issue stands, as the one glyph GitHub marks it with
 * rather than a word, so a long list scans down its left edge.
 */
export function StateMark({ kind, state, draft = false }: { kind: "pull" | "issue"; state: string; draft?: boolean }) {
    const tone = stateOf(state, draft);
    const label = (kind === "pull" ? PULL_LABEL : ISSUE_LABEL)[tone] ?? tone;
    const Glyph = tone === "merged" ? IconPullRequest : tone === "closed" ? IconClose : kind === "pull" ? IconPullRequest : IconCheck;
    return (
        <span className="gha-state-mark" data-state={tone} title={label} aria-label={label} role="img">
            <Glyph size={13} />
        </span>
    );
}
