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

function applyTransparentState() {
    document.documentElement.classList.toggle("is-transparent", currentOpacity < 1);
}

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
    pushThemeOnto(view);
    views.add(view);
    return () => views.delete(view);
}

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

export function applyWindowOpacity(opacity: number): void {
    const v = Math.max(0, Math.min(1, opacity));
    currentOpacity = v;
    document.documentElement.style.setProperty("--window-opacity", String(v));
    applyTransparentState();
    applyTerminalThemes();
}
