export type TerminalRenderer = "dom" | "webgl";

/**
 * WebGL is the default renderer; the DOM fallback stays reachable through the
 * context-loss handler. Vite environment values are strings, but accepting
 * booleans keeps the gate straightforward to test and reuse.
 */
export function terminalWebglRequested(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return true;
    const normalized = value.trim().toLowerCase();
    return normalized !== "0" && normalized !== "false";
}
