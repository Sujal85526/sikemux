import type { ReactNode } from "react";
import type { JiraIssueSummary } from "../api";

function Glyph({ tone, title, children }: { tone: string; title: string; children: ReactNode }) {
    return (
        <svg
            className={`jira-glyph jira-tone-${tone}`}
            width={14}
            height={14}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            role="img"
            aria-label={title}>
            <title>{title}</title>
            {children}
        </svg>
    );
}

const TYPES: Record<string, [string, ReactNode]> = {
    bug: [
        "danger",
        <>
            <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
            <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
        </>,
    ],
    story: ["live", <path d="M4.5 2.5h7v11L8 10.8l-3.5 2.7Z" />],
    task: [
        "blue",
        <>
            <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
            <path d="m5.4 8.1 1.8 1.8 3.5-3.6" />
        </>,
    ],
    subtask: [
        "blue",
        <>
            <rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.5" />
            <rect x="7" y="7" width="6.5" height="6.5" rx="1.5" />
        </>,
    ],
    epic: ["warn", <path d="M9 1.8 3.6 9h4l-1 5.2L12.4 7h-4Z" />],
};

/** An issue's type as the small coloured mark Jira puts beside its key. */
export function IssueTypeIcon({ type }: { type: string | null }) {
    if (!type) return null;
    const known = TYPES[type.toLowerCase().replace(/[^a-z]/g, "")];
    const [tone, shape] = known ?? [
        "muted",
        <>
            <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
            <path d="M8 5.5v3M8 10.6v.1" />
        </>,
    ];
    return (
        <Glyph tone={tone} title={type}>
            {shape}
        </Glyph>
    );
}

const PRIORITIES: Record<string, [string, string]> = {
    highest: ["danger", "M4 8.5 8 4.5l4 4M4 12.5l4-4 4 4"],
    high: ["danger", "M4 10.5 8 6.5l4 4"],
    medium: ["warn", "M3.5 6.5h9M3.5 9.5h9"],
    low: ["blue", "M4 5.5 8 9.5l4-4"],
    lowest: ["blue", "M4 3.5 8 7.5l4-4M4 7.5l4 4 4-4"],
};

/** A priority as Jira draws it: chevrons up for urgent, bars for medium, chevrons down for low. */
export function PriorityGlyph({ priority }: { priority: string | null }) {
    if (!priority) return null;
    const [tone, path] = PRIORITIES[priority.toLowerCase()] ?? ["muted", "M3.5 8h9"];
    return (
        <Glyph tone={tone} title={`${priority} priority`}>
            <path d={path} />
        </Glyph>
    );
}

/** An issue's key, struck through once the issue is done, as Jira shows it. */
export function IssueKey({ issue, className = "jira-key" }: { issue: Pick<JiraIssueSummary, "key" | "statusCategory">; className?: string }) {
    return <span className={`${className}${issue.statusCategory === "done" ? " done" : ""}`}>{issue.key}</span>;
}
