// Theme application bus. CodeMirror views and xterm terminals register
// themselves on mount; calling `applyTheme(id)` updates CSS variables,
// reconfigures every live CM view's theme compartment, and patches every
// live xterm's theme option.

import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Terminal } from "@xterm/xterm";
import { DEFAULT_THEME_ID, themeById, type Theme } from ".";
import { buildEditorExtensions } from "../editor/themeExtensions";

let current: Theme = themeById(DEFAULT_THEME_ID);
let currentOpacity = 1;

const themeCompartment = new Compartment();
const views = new Set<EditorView>();
const terms = new Set<Terminal>();

// When opacity < 1, tag <html> so CSS keeps only the body's dark wash and
// makes every surface stacked on top (chrome strips, panes, terminal) fully
// transparent. Otherwise body·chrome·pane·terminal each at α=0.7 compounds
// to ~0.97 effective in the worst spots — much darker than Ghostty at the
// same slider value. The wash itself uses the theme's own bg colour.
function applyTransparentState() {
    document.documentElement.classList.toggle("is-transparent", currentOpacity < 1);
}

// Terminal theme. At opacity 1 we use the theme's own background; below 1
// the cells become fully transparent so the body's single dark wash shows
// through xterm without adding another layer on top.
function terminalThemeFor(theme: Theme) {
    if (currentOpacity >= 1) return theme.terminal;
    return { ...theme.terminal, background: "rgba(0, 0, 0, 0)" };
}

function applyTerminalThemes() {
    const t = terminalThemeFor(current);
    terms.forEach((term) => {
        term.options.theme = t;
    });
}

export function currentTheme(): Theme {
    return current;
}

export function themeCompartmentExtension() {
    return themeCompartment.of(buildEditorExtensions(current));
}

function pushThemeOnto(view: EditorView): void {
    view.dispatch({
        effects: themeCompartment.reconfigure(buildEditorExtensions(current)),
    });
}

export function registerView(view: EditorView): () => void {
    // Apply the current theme *now* — covers the common case where boot
    // hydrate fires applyTheme before any EditorPane has mounted, leaving the
    // freshly-mounted view stuck on the module-load (default) theme.
    pushThemeOnto(view);
    views.add(view);
    return () => views.delete(view);
}

/**
 * Push the active theme onto a live view. EditorPane calls this after
 * `view.setState(...)` so per-tab restored states honor the current theme.
 */
export function refreshViewTheme(view: EditorView): void {
    pushThemeOnto(view);
}

export function registerTerminal(term: Terminal): () => void {
    term.options.theme = terminalThemeFor(current);
    terms.add(term);
    return () => terms.delete(term);
}

function applyChrome(theme: Theme) {
    const c = theme.chrome;
    const root = document.documentElement.style;

    // Modern variable names — what new components should target.
    root.setProperty("--bg", c.bg);
    root.setProperty("--bg-dim", c.bgDim);
    root.setProperty("--bg-raised", c.bgRaised);
    root.setProperty("--ink", c.ink);
    root.setProperty("--ink-dim", c.inkDim);
    root.setProperty("--ink-muted", c.inkMuted);
    root.setProperty("--acc", c.acc);
    root.setProperty("--acc-line", c.accLine);
    root.setProperty("--acc-dim", c.accDim);
    root.setProperty("--line", c.line);
    root.setProperty("--hl", c.hl);
    root.setProperty("--danger", c.danger);

    // Legacy aliases. Older stylesheets used --void / --rail / --pane /
    // --ink-faint / --acc-soft / --live / --warn / --cmd. Bridge them so
    // theme switching takes effect throughout the app without a CSS rewrite.
    //
    root.setProperty("--void", c.bgDim);
    root.setProperty("--rail", c.bg);
    root.setProperty("--rail-2", c.bgRaised);
    root.setProperty("--pane", c.bg);
    root.setProperty("--line-soft", c.bgRaised);
    root.setProperty("--ink-faint", c.inkMuted);
    root.setProperty("--acc-soft", c.accDim);
    root.setProperty("--live", theme.highlight.string);
    root.setProperty("--warn", theme.highlight.number);
    root.setProperty("--cmd", theme.highlight.function);

    applyTransparentState();
}

export function applyTheme(id: string): void {
    const next = themeById(id);
    current = next;
    applyChrome(next);
    const ext = buildEditorExtensions(next);
    views.forEach((view) => {
        view.dispatch({ effects: themeCompartment.reconfigure(ext) });
    });
    applyTerminalThemes();
}

/** Apply a CSS opacity for the app body. Slider value 0.0 .. 1.0. */
export function applyWindowOpacity(opacity: number): void {
    const v = Math.max(0, Math.min(1, opacity));
    currentOpacity = v;
    document.documentElement.style.setProperty("--window-opacity", String(v));
    applyTransparentState();
    applyTerminalThemes();
}
