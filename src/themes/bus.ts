import { readableColor } from "../lib/themeContrast";
import type { EditorView } from "@codemirror/view";
import type { ITheme, Terminal } from "@xterm/xterm";
import { DEFAULT_THEME_ID, themeById, type Theme } from ".";

let current: Theme = themeById(DEFAULT_THEME_ID);
let currentOpacity = 1;

const views = new Set<EditorView>();
const terms = new Set<Terminal>();

/** What an editor view needs from a theme change. Supplied by `editor/themeBridge`
 *  the first time a view registers, so nothing here pulls CodeMirror into the boot bundle. */
export interface EditorThemeBridge {
    rebuild(theme: Theme): void;
    push(view: EditorView): void;
}

let editorBridge: EditorThemeBridge | null = null;
let bridgeRequested = false;

export function setEditorThemeBridge(bridge: EditorThemeBridge): void {
    editorBridge = bridge;
    bridge.rebuild(current);
    views.forEach((view) => bridge.push(view));
}

function loadEditorBridge(): void {
    if (editorBridge || bridgeRequested) return;
    bridgeRequested = true;
    void import("../editor/themeBridge");
}

const customRegistry = new Map<string, Theme>();
const themeListeners = new Set<(theme: Theme) => void>();

/** Keep the bus aware of user-defined themes so {@link applyTheme} can resolve their ids. */
export function registerCustomThemes(list: readonly Theme[]): void {
    customRegistry.clear();
    for (const t of list) customRegistry.set(t.id, t);
}

function resolveTheme(id: string): Theme {
    return customRegistry.get(id) ?? themeById(id);
}

function applyTransparentState() {
    document.documentElement.classList.toggle("is-transparent", currentOpacity < 1);
}

function terminalThemeFor(theme: Theme): ITheme {
    return {
        ...theme.terminal,
        // Always transparent so the pane's surface shows through the canvas.
        // xterm paints this itself, below CSS, so any opaque value here put a
        // darker rectangle in the middle of the chrome that no stylesheet
        // could reach.
        background: "rgba(0, 0, 0, 0)",
        // xterm 6 renders its own scrollbar and injects slider styles after the
        // app stylesheet. Keep it unobtrusive until the terminal is hovered.
        scrollbarSliderBackground: "rgba(0, 0, 0, 0)",
        scrollbarSliderHoverBackground: theme.chrome.inkMuted,
        scrollbarSliderActiveBackground: theme.chrome.inkDim,
    };
}

/* The one sanitized terminal palette. Construction and later theme changes
 * must both go through this; a Terminal built straight from theme.terminal
 * carries the opaque background this function exists to strip. */
export function currentTerminalTheme(): ITheme {
    return terminalThemeFor(current);
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

export function subscribeTheme(listener: (theme: Theme) => void): () => void {
    themeListeners.add(listener);
    return () => themeListeners.delete(listener);
}

export function registerView(view: EditorView): () => void {
    loadEditorBridge();
    editorBridge?.push(view);
    views.add(view);
    return () => views.delete(view);
}

export function refreshViewTheme(view: EditorView): void {
    editorBridge?.push(view);
}

export function registerTerminal(term: Terminal): () => void {
    term.options.theme = terminalThemeFor(current);
    terms.add(term);
    return () => terms.delete(term);
}

function applyChrome(theme: Theme) {
    const c = theme.chrome;
    const root = document.documentElement.style;

    root.setProperty("--bg", c.bg);
    root.setProperty("--bg-dim", c.bgDim);
    root.setProperty("--bg-raised", c.bgRaised);
    root.setProperty("--ink", c.ink);
    root.setProperty("--ink-dim", c.inkDim);
    const muted = readableColor(c.inkDim, [c.bg, c.bgDim, c.bgRaised], c.ink);
    root.setProperty("--ink-muted", muted);
    root.setProperty("--text-tertiary", muted);
    root.setProperty("--acc", c.acc);
    root.setProperty("--acc-line", c.accLine);
    root.setProperty("--acc-dim", c.accDim);
    root.setProperty("--line", c.line);
    root.setProperty("--hl", c.hl);
    root.setProperty("--danger", readableColor(c.danger, [c.bg, c.bgDim, c.bgRaised], c.ink));

    root.setProperty("--void", c.bgDim);
    root.setProperty("--rail", c.bg);
    root.setProperty("--rail-2", c.bgRaised);
    root.setProperty("--pane", c.bg);
    root.setProperty("--line-soft", c.bgRaised);
    root.setProperty("--ink-faint", muted);
    root.setProperty("--acc-soft", c.accDim);
    root.setProperty("--live", readableColor(theme.dark ? "#78dca1" : "#247345", [c.bg, c.bgRaised], c.ink));
    root.setProperty("--warn", readableColor(theme.dark ? "#e9ba6c" : "#875508", [c.bg, c.bgRaised], c.ink));
    for (const [token, color] of Object.entries({
        "--git-modified": theme.dark ? "#e2c08d" : "#875508",
        "--git-untracked": theme.dark ? "#73c991" : "#247345",
        "--git-added": theme.dark ? "#81b88b" : "#247345",
        "--git-deleted": theme.dark ? "#ed806b" : "#aa3824",
        "--git-renamed": theme.dark ? "#94b1ef" : "#345bad",
    }))
        root.setProperty(token, readableColor(color, [c.bg, c.bgDim, c.bgRaised], c.ink));
    root.setProperty("--cmd", theme.highlight.function);
    root.setProperty("--terminal-background", theme.terminal.background);

    applyTransparentState();
}

function applyThemeObject(next: Theme): void {
    const root = document.documentElement;
    root.classList.add("theme-changing");
    void root.offsetWidth;
    current = next;
    applyChrome(next);
    editorBridge?.rebuild(next);
    if (editorBridge) views.forEach(editorBridge.push);
    applyTerminalThemes();
    themeListeners.forEach((listener) => listener(next));
    void root.offsetWidth;
    requestAnimationFrame(() => root.classList.remove("theme-changing"));
}

export function applyTheme(id: string): void {
    applyThemeObject(resolveTheme(id));
}

/** Apply a theme object directly without touching the persisted selection — used for live editing previews. */
export function previewTheme(theme: Theme): void {
    applyThemeObject(theme);
}

export function applyWindowOpacity(opacity: number): void {
    const v = Math.max(0, Math.min(1, opacity));
    currentOpacity = v;
    document.documentElement.style.setProperty("--window-opacity", String(v));
    applyTransparentState();
    applyTerminalThemes();
}
