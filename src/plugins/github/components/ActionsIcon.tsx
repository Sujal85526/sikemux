import { IconCheck, IconClock, IconClose, IconPullRequest, IconRun, IconStop, IconWarning } from "../../../plugin-api/ui";
import { OUTCOME_LABEL, type Outcome } from "../runStatus";
import type { Section } from "../state";

export function GithubMark({ size = 16, className }: { size?: number; className?: string }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
    );
}

const GLYPH: Record<Outcome, typeof IconCheck> = {
    running: IconRun,
    queued: IconClock,
    success: IconCheck,
    failure: IconClose,
    cancelled: IconStop,
    skipped: IconClock,
    blocked: IconWarning,
    unknown: IconWarning,
};

export function OutcomeIcon({ outcome, size = 13 }: { outcome: Outcome; size?: number }) {
    const Glyph = GLYPH[outcome];
    return (
        <span className="gha-outcome" data-outcome={outcome} title={OUTCOME_LABEL[outcome]} aria-label={OUTCOME_LABEL[outcome]} role="img">
            <Glyph size={size} />
        </span>
    );
}

export function MoreDots({ size = 13 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="13" cy="8" r="1.4" />
        </svg>
    );
}

function Stroke({ size, children }: { size: number; children: React.ReactNode }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true">
            {children}
        </svg>
    );
}

export function SectionIcon({ section, size = 14 }: { section: Section; size?: number }) {
    switch (section) {
        case "actions":
            return (
                <Stroke size={size}>
                    <circle cx="8" cy="8" r="6" />
                    <path d="M6.7 5.6 10.3 8l-3.6 2.4z" />
                </Stroke>
            );
        case "pulls":
            return <IconPullRequest size={size} />;
        case "issues":
            return (
                <Stroke size={size}>
                    <circle cx="8" cy="8" r="6" />
                    <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
                </Stroke>
            );
        case "releases":
            return (
                <Stroke size={size}>
                    <path d="M2.5 3.5v3.4c0 .4.2.8.4 1l5.2 5.2a1.2 1.2 0 0 0 1.7 0l3.3-3.3a1.2 1.2 0 0 0 0-1.7L7.9 2.9a1.4 1.4 0 0 0-1-.4H3.5a1 1 0 0 0-1 1Z" />
                    <circle cx="5.3" cy="5.3" r=".8" fill="currentColor" stroke="none" />
                </Stroke>
            );
        case "inbox":
            return (
                <Stroke size={size}>
                    <path d="M2.2 8.8 4 3.4c.2-.5.6-.9 1.2-.9h5.6c.6 0 1 .4 1.2.9l1.8 5.4" />
                    <path d="M2.2 8.8v3.4c0 .7.6 1.3 1.3 1.3h9c.7 0 1.3-.6 1.3-1.3V8.8h-3.2L9.6 10.4H6.4L5.4 8.8Z" />
                </Stroke>
            );
    }
}

export function UpDown({ size = 12 }: { size?: number }) {
    return (
        <Stroke size={size}>
            <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
        </Stroke>
    );
}
