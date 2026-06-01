import type { ReactNode } from "react";

// Real macOS modifier glyphs — never tmux-style "M-"/"C-"/"S-" notation.
export const CMD = "⌘";
export const ALT = "⌥";
export const SHIFT = "⇧";
export const CTRL = "⌃";

/** A shortcut string for use inside title="" tooltips, e.g. hint(ALT, "S") -> "⌥S". */
export function hint(...parts: string[]): string {
    return parts.join("");
}

/** A styled shortcut chip for visible UI, e.g. <Kbd>{ALT}S</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
    return <span className="kbd">{children}</span>;
}
