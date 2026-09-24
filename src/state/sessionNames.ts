import type { SessionKind } from "./types";

/** Sessions there is only ever one of go by the tool's own name. */
export const FIXED_SESSION_NAMES = {
    aws: "AWS",
    bruno: "Bruno",
} as const satisfies Partial<Record<SessionKind, string>>;

export function fixedSessionName(kind: SessionKind): string | undefined {
    return kind in FIXED_SESSION_NAMES ? FIXED_SESSION_NAMES[kind as keyof typeof FIXED_SESSION_NAMES] : undefined;
}
