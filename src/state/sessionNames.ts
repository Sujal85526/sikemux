import { pluginSurface } from "../plugins/registry";
import type { SessionKind } from "./types";

/** Sessions there is only ever one of go by the tool's own name. */
export const FIXED_SESSION_NAMES = {
    bruno: "Bruno",
} as const satisfies Partial<Record<SessionKind, string>>;

/** A plugin's session is named after its surface, the way Bruno's is named Bruno. */
export function fixedSessionName(kind: SessionKind): string | undefined {
    if (kind in FIXED_SESSION_NAMES) return FIXED_SESSION_NAMES[kind as keyof typeof FIXED_SESSION_NAMES];
    return pluginSurface(kind)?.title;
}
