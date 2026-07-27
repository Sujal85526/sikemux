export type TerminalRenderer = "dom" | "webgl";

/**
 * WebGL stays opt-in until it has been exercised against WKWebView's
 * transparent-window redraw path. Vite environment values are strings, but
 * accepting booleans keeps the gate straightforward to test and reuse.
 */
export function terminalWebglRequested(value: unknown): boolean {
    if (value === true) return true;
    if (typeof value !== "string") return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
}
