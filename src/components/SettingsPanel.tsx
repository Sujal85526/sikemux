import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { settingsApi } from "../api/settings";
import { prettyPath } from "../lib/paths";
import { notify, reportError } from "../state/toast";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { cloneTheme, newCustomThemeId, THEME_GROUPS, THEMES, THEMES_BY_ID, type Theme, type ThemeGroupKey } from "../themes";
import { IconCheck, IconClose, IconFolder, IconPencil, IconPlus, IconSave, IconTrash } from "./Icons";

type Page = "general" | "appearance" | "cloud";

const PAGES: { id: Page; name: string }[] = [
    { id: "general", name: "general" },
    { id: "appearance", name: "appearance" },
    { id: "cloud", name: "cloud" },
];

export function SettingsPanel() {
    const pinnedProjects = useStore((s) => s.pinnedProjects);
    const projectRoots = useStore((s) => s.projectRoots);
    const themeId = useStore((s) => s.themeId);
    const windowOpacity = useStore((s) => s.windowOpacity);
    const windowBlur = useStore((s) => s.windowBlur);
    const cloudBrowser = useStore((s) => s.cloudBrowser);
    const cloudBrowserShortcut = useStore((s) => s.cloudBrowserShortcut);
    const home = useStore((s) => s.home);

    const [page, setPage] = useState<Page>("general");

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                cmd.closeSettings();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const pretty = (p: string) => prettyPath(p, home);

    return (
        <div className="settings-pane">
            <div className="settings-frame">
                <aside className="settings-rail">
                    <div className="settings-rail-head">
                        <span className="settings-logo-mark">▶</span>
                        <span className="settings-logo-text">sikemux</span>
                        <span className="settings-logo-tag">settings</span>
                    </div>

                    <nav className="settings-rail-list">
                        {PAGES.map((p, i) => (
                            <button
                                key={p.id}
                                className={`settings-rail-item${page === p.id ? " active" : ""}`}
                                onClick={() => setPage(p.id)}
                                type="button">
                                <span className="settings-rail-num">{String(i + 1).padStart(2, "0")}</span>
                                <span className="settings-rail-name">{p.name}</span>
                            </button>
                        ))}
                    </nav>

                    <div className="settings-rail-foot">
                        <span className="settings-rail-path">~/.config/sikemux</span>
                        <button className="settings-close" onClick={cmd.closeSettings} title="Close (Esc / ⌘,)" type="button">
                            <IconClose size={11} /> close
                        </button>
                    </div>
                </aside>

                <div className="settings-main">
                    <div className="settings-crumb">
                        <div className="settings-crumb-path">
                            <span>settings</span>
                            <span className="crumb-sep">/</span>
                            <span className="crumb-group">{page}</span>
                        </div>
                        <div className="settings-crumb-meta">
                            autosave on · <kbd>⌘,</kbd> close
                        </div>
                    </div>

                    <div className="settings-scroll">
                        {page === "general" && (
                            <GeneralPage pinnedProjects={pinnedProjects} projectRoots={projectRoots} home={home} pretty={pretty} />
                        )}

                        {page === "appearance" && <AppearancePage themeId={themeId} windowOpacity={windowOpacity} windowBlur={windowBlur} />}

                        {page === "cloud" && <CloudPage cloudBrowser={cloudBrowser} cloudBrowserShortcut={cloudBrowserShortcut} />}
                    </div>
                </div>
            </div>
        </div>
    );
}

interface GeneralPageProps {
    pinnedProjects: Array<{ path: string }>;
    projectRoots: Array<{ path: string; depth: number }>;
    home: string;
    pretty: (p: string) => string;
}

function GeneralPage({ pinnedProjects, projectRoots, home, pretty }: GeneralPageProps) {
    const [pinnedDraftPath, setPinnedDraftPath] = useState("");
    const [rootDraftPath, setRootDraftPath] = useState("");
    const [rootDraftDepth, setRootDraftDepth] = useState(1);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const resolveDirectory = async (raw: string) => {
        const expanded = await settingsApi.expandPath(raw);
        const ok = await settingsApi.isDirectory(expanded);
        if (!ok) {
            notify("error", `settings: not a directory: ${pretty(expanded)}`);
            return null;
        }
        return expanded;
    };

    const commitPinnedDraft = async () => {
        const raw = pinnedDraftPath.trim();
        if (!raw) return;
        try {
            const expanded = await resolveDirectory(raw);
            if (!expanded) return;
            cmd.addPinnedProject(expanded);
            setPinnedDraftPath("");
        } catch (err) {
            reportError("settings")(err);
        }
    };

    const commitRootDraft = async () => {
        const raw = rootDraftPath.trim();
        if (!raw) return;
        try {
            const expanded = await resolveDirectory(raw);
            if (!expanded) return;
            cmd.addProjectRoot(expanded, rootDraftDepth);
            setRootDraftPath("");
            setRootDraftDepth(1);
        } catch (err) {
            reportError("settings")(err);
        }
    };

    const onPickPinned = async () => {
        try {
            const picked = await settingsApi.pickFolder(home || undefined);
            if (picked) cmd.addPinnedProject(picked);
        } catch (err) {
            reportError("folder picker")(err);
        }
    };

    const onPickRoot = async () => {
        try {
            const picked = await settingsApi.pickFolder(home || undefined);
            if (picked) cmd.addProjectRoot(picked, rootDraftDepth);
        } catch (err) {
            reportError("folder picker")(err);
        }
    };

    return (
        <SettingsPage name="general" deck="Exact project folders and git repo discovery for the session picker.">
            <SettingsSection
                title="Pinned projects"
                meta={`${pinnedProjects.length} ${pinnedProjects.length === 1 ? "entry" : "entries"}`}
                sub="Exact folders that always appear in the sesh picker, git repo or not.">
                <div className="settings-row-input compact">
                    <input
                        ref={inputRef}
                        className="settings-input"
                        placeholder="~/    or    /Users/me/scratch"
                        value={pinnedDraftPath}
                        onChange={(e) => setPinnedDraftPath(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                void commitPinnedDraft();
                            } else if (e.key === "Escape") {
                                cmd.closeSettings();
                            }
                        }}
                        spellCheck={false}
                    />
                    <button className="settings-btn" onClick={onPickPinned} type="button" title="Browse…">
                        <IconFolder size={11} /> browse
                    </button>
                    <button
                        className="settings-btn primary"
                        onClick={() => void commitPinnedDraft()}
                        disabled={!pinnedDraftPath.trim()}
                        type="button">
                        <IconPlus size={11} /> add
                    </button>
                </div>

                {pinnedProjects.length === 0 ? (
                    <div className="settings-empty">
                        no pinned projects — use the folder button in the sesh picker, or add <code>~/</code> here
                    </div>
                ) : (
                    <div className="settings-list">
                        {pinnedProjects.map((project, i) => (
                            <div className="settings-list-row" key={project.path}>
                                <span className="settings-list-idx">{String(i + 1).padStart(2, "0")}</span>
                                <span className="settings-list-path">{pretty(project.path)}</span>
                                <button className="settings-row-x" onClick={() => cmd.removePinnedProject(project.path)} title="Remove" type="button">
                                    <IconClose size={11} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </SettingsSection>

            <SettingsSection
                title="Discovery roots"
                meta={`${projectRoots.length} ${projectRoots.length === 1 ? "entry" : "entries"}`}
                sub="Scans for git repos only. The root itself appears only when it is a git repo.">
                <div className="settings-row-input">
                    <input
                        className="settings-input"
                        placeholder="~/proj    or    /Users/me/work"
                        value={rootDraftPath}
                        onChange={(e) => setRootDraftPath(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                void commitRootDraft();
                            } else if (e.key === "Escape") {
                                cmd.closeSettings();
                            }
                        }}
                        spellCheck={false}
                    />
                    <DepthStepper value={rootDraftDepth} onChange={setRootDraftDepth} title="Walk depth for this root" />
                    <button className="settings-btn" onClick={onPickRoot} type="button" title="Browse…">
                        <IconFolder size={11} /> browse
                    </button>
                    <button className="settings-btn primary" onClick={() => void commitRootDraft()} disabled={!rootDraftPath.trim()} type="button">
                        <IconPlus size={11} /> add
                    </button>
                </div>

                {projectRoots.length === 0 ? (
                    <div className="settings-empty">
                        no discovery roots — add <code>~/proj</code> (or wherever you keep code) to find git repos
                    </div>
                ) : (
                    <div className="settings-list">
                        {projectRoots.map((root, i) => (
                            <div className="settings-list-row" key={root.path}>
                                <span className="settings-list-idx">{String(i + 1).padStart(2, "0")}</span>
                                <span className="settings-list-path">{pretty(root.path)}</span>
                                <DepthStepper value={root.depth} onChange={(d) => cmd.setProjectRootDepth(root.path, d)} title="Walk depth" />
                                <button className="settings-row-x" onClick={() => cmd.removeProjectRoot(root.path)} title="Remove" type="button">
                                    <IconClose size={11} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </SettingsSection>
        </SettingsPage>
    );
}

interface AppearancePageProps {
    themeId: string;
    windowOpacity: number;
    windowBlur: number;
}

interface ThemeEdit {
    theme: Theme;
    /** Pristine source the draft was forked from — used by "reset". */
    original: Theme;
    /** true ⇒ save inserts a new custom theme · false ⇒ overwrites an existing one. */
    isNew: boolean;
    baseName: string;
}

function AppearancePage({ themeId, windowOpacity, windowBlur }: AppearancePageProps) {
    const customThemes = useStore((s) => s.customThemes);
    const [edit, setEdit] = useState<ThemeEdit | null>(null);
    const editorRef = useRef<HTMLDivElement>(null);

    // Drive the whole-app live preview off the working draft; restore on close/unmount.
    useEffect(() => {
        if (edit) cmd.previewThemeDraft(edit.theme);
    }, [edit]);
    useEffect(() => () => cmd.cancelThemePreview(), []);

    const openEditor = (next: ThemeEdit) => {
        setEdit(next);
        requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    };

    const customizeFrom = (src: Theme) =>
        openEditor({
            theme: cloneTheme(src, { id: newCustomThemeId(), name: `${src.name} custom` }),
            original: cloneTheme(src),
            isNew: true,
            baseName: src.name,
        });

    const editCustom = (src: Theme) => openEditor({ theme: cloneTheme(src), original: cloneTheme(src), isNew: false, baseName: src.name });

    const newFromActive = () => customizeFrom(THEMES_BY_ID[themeId] ?? customThemes.find((t) => t.id === themeId) ?? THEMES[0]);

    const closeEditor = () => {
        setEdit(null);
        cmd.cancelThemePreview();
    };

    const saveEditor = () => {
        if (!edit) return;
        cmd.saveCustomTheme({ ...edit.theme, name: edit.theme.name.trim() || "custom theme" });
        setEdit(null);
    };

    const renderCard = (th: Theme, custom: boolean) => {
        const active = th.id === themeId;
        const editing = edit?.theme.id === th.id;
        return (
            <div key={th.id} className={`settings-theme${active ? " active" : ""}${editing ? " editing" : ""}`}>
                <button className="settings-theme-hit" onClick={() => cmd.setThemeId(th.id)} title={`Apply ${th.name}`} type="button">
                    <div className="settings-theme-name">{th.name}</div>
                    <div className="settings-swatches">
                        <span style={{ background: th.terminal.red }} />
                        <span style={{ background: th.terminal.green }} />
                        <span style={{ background: th.terminal.yellow }} />
                        <span style={{ background: th.terminal.blue }} />
                        <span style={{ background: th.terminal.magenta }} />
                        <span style={{ background: th.terminal.cyan }} />
                    </div>
                </button>
                <div className="settings-theme-actions">
                    {custom ? (
                        <>
                            <button className="settings-theme-act" onClick={() => editCustom(th)} title="Edit theme" type="button">
                                <IconPencil size={11} />
                            </button>
                            <button
                                className="settings-theme-act danger"
                                onClick={() => cmd.deleteCustomTheme(th.id)}
                                title="Delete theme"
                                type="button">
                                <IconTrash size={11} />
                            </button>
                        </>
                    ) : (
                        <button className="settings-theme-act" onClick={() => customizeFrom(th)} title="Customize a copy" type="button">
                            <IconPencil size={11} />
                        </button>
                    )}
                </div>
                {custom && <span className="settings-theme-badge">custom</span>}
            </div>
        );
    };

    return (
        <SettingsPage name="appearance" deck="Theme, window opacity and background blur. Changes apply instantly.">
            <SettingsSection
                title="Theme"
                meta={`${THEMES.length} built-in · ${customThemes.length} custom`}
                sub="Applies instantly to chrome, editor and terminal — no reload. Hover a swatch to customize or delete.">
                <div className="settings-theme-grid">{THEMES.map((th) => renderCard(th, false))}</div>

                {customThemes.length > 0 && (
                    <>
                        <div className="settings-theme-divider">your themes</div>
                        <div className="settings-theme-grid">{customThemes.map((th) => renderCard(th, true))}</div>
                    </>
                )}

                <div className="settings-theme-newrow">
                    <button className="settings-btn" onClick={newFromActive} type="button" title="Fork the active theme into a new editable copy">
                        <IconPlus size={11} /> new from current
                    </button>
                </div>
            </SettingsSection>

            {edit && (
                <div ref={editorRef}>
                    <ThemeEditor
                        edit={edit}
                        onColor={(group, key, value) =>
                            setEdit((e) =>
                                e
                                    ? {
                                          ...e,
                                          theme: { ...e.theme, [group]: { ...(e.theme[group] as unknown as Record<string, string>), [key]: value } },
                                      }
                                    : e,
                            )
                        }
                        onName={(name) => setEdit((e) => (e ? { ...e, theme: { ...e.theme, name } } : e))}
                        onDark={(dark) => setEdit((e) => (e ? { ...e, theme: { ...e.theme, dark } } : e))}
                        onReset={() => setEdit((e) => (e ? { ...e, theme: { ...cloneTheme(e.original), id: e.theme.id, name: e.theme.name } } : e))}
                        onSave={saveEditor}
                        onCancel={closeEditor}
                    />
                </div>
            )}

            <SettingsSection title="Window opacity" sub="0.00 transparent · 1.00 opaque.">
                <div className="settings-knob-row">
                    <input
                        type="range"
                        className="settings-slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={windowOpacity}
                        onChange={(e) => cmd.setWindowOpacity(parseFloat(e.target.value))}
                    />
                    <NumberField value={windowOpacity} onCommit={cmd.setWindowOpacity} format={(v) => v.toFixed(2)} suffix="opacity" />
                </div>
            </SettingsSection>

            <SettingsSection title="Background blur" meta="px radius" sub="0 none · 20–40 frosted.">
                <div className="settings-knob-row">
                    <input
                        type="range"
                        className="settings-slider alt"
                        min={0}
                        max={60}
                        step={1}
                        value={Math.min(60, windowBlur)}
                        onChange={(e) => cmd.setWindowBlur(parseInt(e.target.value, 10))}
                    />
                    <NumberField
                        value={windowBlur}
                        onCommit={(v) => cmd.setWindowBlur(Math.round(v))}
                        format={(v) => String(Math.round(v))}
                        suffix="px"
                    />
                </div>
            </SettingsSection>
        </SettingsPage>
    );
}

interface ThemeEditorProps {
    edit: ThemeEdit;
    onColor: (group: ThemeGroupKey, key: string, value: string) => void;
    onName: (name: string) => void;
    onDark: (dark: boolean) => void;
    onReset: () => void;
    onSave: () => void;
    onCancel: () => void;
}

function ThemeEditor({ edit, onColor, onName, onDark, onReset, onSave, onCancel }: ThemeEditorProps) {
    const { theme, isNew, baseName } = edit;
    return (
        <section className="theme-editor">
            <header className="theme-editor-head">
                <div className="theme-editor-title">
                    <span className="theme-editor-kicker">{isNew ? "new theme" : "editing"}</span>
                    <input
                        className="theme-editor-name"
                        value={theme.name}
                        spellCheck={false}
                        placeholder="theme name"
                        onChange={(e) => onName(e.target.value)}
                        autoFocus
                    />
                    <span className="theme-editor-base">based on {baseName}</span>
                </div>
                <div className="theme-editor-tools">
                    <button
                        className={`theme-mode-toggle${theme.dark ? " dark" : " light"}`}
                        onClick={() => onDark(!theme.dark)}
                        type="button"
                        title="Editor light/dark hint — affects CodeMirror defaults">
                        {theme.dark ? "dark" : "light"}
                    </button>
                    <button className="settings-btn" onClick={onReset} type="button" title="Revert all colours to the source theme">
                        reset
                    </button>
                    <button className="settings-btn" onClick={onCancel} type="button">
                        <IconClose size={11} /> cancel
                    </button>
                    <button className="settings-btn primary" onClick={onSave} type="button">
                        {isNew ? <IconSave size={11} /> : <IconCheck size={11} />} {isNew ? "save theme" : "update"}
                    </button>
                </div>
            </header>

            <ThemePreview theme={theme} />

            <div className="theme-editor-groups">
                {THEME_GROUPS.map((group) => (
                    <div className="theme-group" key={group.key}>
                        <div className="theme-group-head">
                            <h3 className="theme-group-title">{group.label}</h3>
                            <span className="theme-group-hint">{group.hint}</span>
                        </div>
                        <div className="theme-group-grid">
                            {group.fields.map((field) => (
                                <ColorField
                                    key={field.key}
                                    label={field.label}
                                    value={(theme[group.key] as unknown as Record<string, string>)[field.key]}
                                    onChange={(v) => onColor(group.key, field.key, v)}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
            <p className="theme-editor-foot">
                Hex or any CSS colour works in the text box — use <em>rgba(…)</em> for translucent washes. The picker only sets hex.
            </p>
        </section>
    );
}

const HEX6 = /^#([0-9a-fA-F]{6})$/;
const HEX3 = /^#([0-9a-fA-F]{3})$/;
const RGB = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i;

/** Best-effort projection of any CSS colour string onto a #rrggbb value for the native colour input. */
function toHex(value: string): string {
    const v = value.trim();
    const m6 = HEX6.exec(v);
    if (m6) return `#${m6[1].toLowerCase()}`;
    const m3 = HEX3.exec(v);
    if (m3) {
        const [r, g, b] = m3[1].split("");
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    const rgb = RGB.exec(v);
    if (rgb) {
        const h = (n: string) =>
            Math.max(0, Math.min(255, Math.round(parseFloat(n))))
                .toString(16)
                .padStart(2, "0");
        return `#${h(rgb[1])}${h(rgb[2])}${h(rgb[3])}`;
    }
    return "#000000";
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
    return (
        <div className="theme-field">
            <label className="theme-field-swatch" style={{ background: value }} title={`${label}: ${value}`}>
                <input type="color" value={toHex(value)} onChange={(e) => onChange(e.target.value)} />
            </label>
            <div className="theme-field-body">
                <span className="theme-field-label">{label}</span>
                <input className="theme-field-hex" value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
            </div>
        </div>
    );
}

function ThemePreview({ theme }: { theme: Theme }) {
    const h = theme.highlight;
    const ansi = [
        theme.terminal.black,
        theme.terminal.red,
        theme.terminal.green,
        theme.terminal.yellow,
        theme.terminal.blue,
        theme.terminal.magenta,
        theme.terminal.cyan,
        theme.terminal.white,
        theme.terminal.brightBlack,
        theme.terminal.brightRed,
        theme.terminal.brightGreen,
        theme.terminal.brightYellow,
        theme.terminal.brightBlue,
        theme.terminal.brightMagenta,
        theme.terminal.brightCyan,
        theme.terminal.brightWhite,
    ];
    return (
        <div className="theme-preview">
            <pre className="theme-preview-code" style={{ background: theme.editor.bg, color: theme.editor.fg }}>
                <span style={{ color: h.comment, fontStyle: "italic" }}>{"// fork a base, tweak, save"}</span>
                {"\n"}
                <span style={{ color: h.keyword }}>const</span> <span style={{ color: h.variable }}>swatch</span>
                <span style={{ color: h.operator }}> = </span>
                <span style={{ color: h.function }}>paint</span>
                <span style={{ color: h.operator }}>(</span>
                <span style={{ color: h.string }}>"#a277ff"</span>
                <span style={{ color: h.operator }}>, </span>
                <span style={{ color: h.number }}>0.3</span>
                <span style={{ color: h.operator }}>);</span>
            </pre>
            <div className="theme-preview-term" style={{ background: theme.terminal.background }}>
                {ansi.map((c, i) => (
                    <span key={i} style={{ background: c }} />
                ))}
            </div>
        </div>
    );
}

interface CloudPageProps {
    cloudBrowser: string;
    cloudBrowserShortcut: string;
}

function CloudPage({ cloudBrowser, cloudBrowserShortcut }: CloudPageProps) {
    return (
        <SettingsPage name="cloud" deck="Where AWS / GCP single sign-on URLs open, and which workspace to bounce to.">
            <SettingsSection title="Sign-in browser" meta="aws · gcp · sso" sub="Where the SSO URL lands. Pick the app you actually log in with.">
                <label className="settings-field-label">browser app</label>
                <input
                    className="settings-input wide"
                    placeholder="e.g. Zen, Arc, Safari · empty = system default"
                    value={cloudBrowser}
                    onChange={(e) => cmd.setCloudBrowser(e.target.value)}
                    spellCheck={false}
                />
                <div className="settings-field-help">must match a running app's name · trailing .app is fine</div>
            </SettingsSection>

            <SettingsSection
                title="Workspace switch"
                meta="optional"
                sub="Fired right after the link opens — point it at the desktop where the browser lives.">
                <label className="settings-field-label">workspace shortcut</label>
                <input
                    className="settings-input wide"
                    placeholder="e.g. ctrl+3 · empty = no switch"
                    value={cloudBrowserShortcut}
                    onChange={(e) => cmd.setCloudBrowserShortcut(e.target.value)}
                    spellCheck={false}
                />
                <div className="settings-field-help">
                    format: <em>mod+key</em> · use system shortcuts from Mission Control
                </div>
            </SettingsSection>
        </SettingsPage>
    );
}

function SettingsPage({ name, deck, children }: { name: string; deck: ReactNode; children: ReactNode }) {
    return (
        <div className="settings-page">
            <header className="settings-page-head">
                <h1 className="settings-page-hd">{name}</h1>
                <p className="settings-page-deck">{deck}</p>
            </header>
            {children}
        </div>
    );
}

function SettingsSection({ title, meta, sub, children }: { title: ReactNode; meta?: ReactNode; sub?: ReactNode; children: ReactNode }) {
    return (
        <section className="settings-section">
            <div className="settings-section-head">
                <h2 className="settings-section-title">{title}</h2>
                {meta && <span className="settings-section-meta">{meta}</span>}
            </div>
            {sub && <p className="settings-section-sub">{sub}</p>}
            {children}
        </section>
    );
}

interface NumberFieldProps {
    value: number;
    onCommit: (v: number) => void;
    format: (v: number) => string;
    suffix?: string;
}

function NumberField({ value, onCommit, format, suffix }: NumberFieldProps) {
    const [draft, setDraft] = useState<string>(() => format(value));
    const focusedRef = useRef(false);

    useEffect(() => {
        if (!focusedRef.current) setDraft(format(value));
    }, [value, format]);

    const commit = () => {
        const n = parseFloat(draft);
        if (Number.isFinite(n)) {
            onCommit(n);
            setDraft(format(n));
        } else {
            setDraft(format(value));
        }
    };

    return (
        <div className="settings-knob-num">
            <input
                type="text"
                inputMode="decimal"
                className="settings-knob-val"
                value={draft}
                spellCheck={false}
                onFocus={() => {
                    focusedRef.current = true;
                }}
                onBlur={() => {
                    focusedRef.current = false;
                    commit();
                }}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                    } else if (e.key === "Escape") {
                        setDraft(format(value));
                        (e.target as HTMLInputElement).blur();
                    }
                }}
            />
            {suffix && <span className="settings-knob-suf">{suffix}</span>}
        </div>
    );
}

function DepthStepper({ value, onChange, title }: { value: number; onChange: (v: number) => void; title?: string }) {
    const [draft, setDraft] = useState<string>(() => String(value));
    const focusedRef = useRef(false);

    useEffect(() => {
        if (!focusedRef.current) setDraft(String(value));
    }, [value]);

    const commit = (raw: string) => {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n)) {
            const clamped = Math.max(0, n);
            onChange(clamped);
            setDraft(String(clamped));
        } else {
            setDraft(String(value));
        }
    };

    const bump = (delta: number) => {
        const next = Math.max(0, value + delta);
        onChange(next);
        setDraft(String(next));
    };

    return (
        <div className="settings-depth" title={title}>
            <span className="settings-depth-label">d</span>
            <button className="settings-depth-btn" onClick={() => bump(-1)} disabled={value <= 0} type="button">
                −
            </button>
            <input
                type="text"
                inputMode="numeric"
                className="settings-depth-input"
                value={draft}
                spellCheck={false}
                onFocus={() => {
                    focusedRef.current = true;
                }}
                onBlur={() => {
                    focusedRef.current = false;
                    commit(draft);
                }}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                    } else if (e.key === "Escape") {
                        setDraft(String(value));
                        (e.target as HTMLInputElement).blur();
                    } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        bump(1);
                    } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        bump(-1);
                    }
                }}
            />
            <button className="settings-depth-btn" onClick={() => bump(1)} type="button">
                +
            </button>
        </div>
    );
}
