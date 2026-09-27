import { IconCheck, IconClose, IconPullRequest } from "../../../plugin-api/ui";
import type { Label } from "../api";

/** Whether a colour GitHub gave a label needs light or dark text on it. */
export function readableOn(hex: string): "light" | "dark" {
    const clean = hex.replace("#", "");
    if (clean.length !== 6) return "light";
    const channel = (at: number) => parseInt(clean.slice(at, at + 2), 16) / 255;
    const [red, green, blue] = [channel(0), channel(2), channel(4)];
    if ([red, green, blue].some(Number.isNaN)) return "light";
    // Rec. 709 luma, which is what tells a yellow label from a navy one.
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.6 ? "dark" : "light";
}

export function Labels({ labels }: { labels: readonly Label[] }) {
    if (labels.length === 0) return null;
    return (
        <>
            {labels.map((label) => (
                <span
                    key={label.name}
                    className="gha-label"
                    data-ink={readableOn(label.color)}
                    style={{ background: `#${label.color}` }}
                    title={label.name}>
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
