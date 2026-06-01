import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { settingsApi } from "../api/settings";
import { prettyPath } from "../lib/paths";
import { reportError } from "../state/toast";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { THEMES } from "../themes";
import { IconClose, IconFolder, IconPlus } from "./Icons";

type Page = "general" | "appearance" | "cloud";

const PAGES: { id: Page; num: string; name: string }[] = [
    { id: "general", num: "[01]", name: "general" },
    { id: "appearance", num: "[02]", name: "appearance" },
    { id: "cloud", num: "[03]", name: "cloud" },
];

export function SettingsPanel() {
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
            <aside className="settings-rail">
                <div className="settings-rail-head">
                    <div className="settings-logo">
                        <span className="settings-logo-mark">▶</span> sikemux · cfg
                    </div>
                    <div className="settings-screen-name">
                        <b>·</b>settings
                    </div>
                    <div className="settings-kbd-line">
                        <kbd>⌘,</kbd> open · <kbd>esc</kbd> close
                    </div>
                </div>

                <div className="settings-rail-list">
                    {PAGES.map((p) => (
                        <button
                            key={p.id}
                            className={`settings-rail-item${page === p.id ? " active" : ""}`}
                            onClick={() => setPage(p.id)}
                            type="button">
                            <span className="settings-rail-num">{p.num}</span>
                            <span className="settings-rail-name">{p.name}</span>
                        </button>
                    ))}
                </div>

                <div className="settings-rail-foot">
                    <span>
                        <b>cfg</b> · ~/.config/sikemux
                    </span>
                </div>

                <button className="settings-close" onClick={cmd.closeSettings} title="Close (Esc / ⌘,)" type="button">
                    <IconClose size={11} /> close
                </button>
            </aside>

            <div className="settings-main">
                <div className="settings-crumb">
                    <div className="settings-crumb-path">
                        <span className="crumb-tag">CFG</span>
                        <span>settings</span>
                        <span className="crumb-sep">›</span>
                        <span className="crumb-group">{page}</span>
                    </div>
                    <div className="settings-crumb-meta">
                        <span>
                            <b>autosave</b> · on
                        </span>
                    </div>
                </div>

                {page === "general" && <GeneralPage projectRoots={projectRoots} home={home} pretty={pretty} />}

                {page === "appearance" && <AppearancePage themeId={themeId} windowOpacity={windowOpacity} windowBlur={windowBlur} />}

                {page === "cloud" && <CloudPage cloudBrowser={cloudBrowser} cloudBrowserShortcut={cloudBrowserShortcut} />}

                <div className="settings-statusline">
                    <div className="left">
                        <span className="mode">CFG</span> &nbsp; settings :: {page}
                    </div>
                    <div className="right">
                        <span>
                            <kbd>⌘,</kbd> close
                        </span>
                        <span>·on autosave</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

interface GeneralPageProps {
    projectRoots: Array<{ path: string; depth: number }>;
    home: string;
    pretty: (p: string) => string;
}

function GeneralPage({ projectRoots, home, pretty }: GeneralPageProps) {
    const [draftPath, setDraftPath] = useState("");
    const [draftDepth, setDraftDepth] = useState(1);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const commitDraft = async () => {
        const raw = draftPath.trim();
        if (!raw) return;
        try {
            const expanded = await settingsApi.expandPath(raw);
            cmd.addProjectRoot(expanded, draftDepth);
            setDraftPath("");
            setDraftDepth(1);
        } catch (err) {
            reportError("settings")(err);
        }
    };

    const onPickFolder = async () => {
        try {
            const picked = await settingsApi.pickFolder(home || undefined);
            if (picked) cmd.addProjectRoot(picked, draftDepth);
        } catch (err) {
            reportError("folder picker")(err);
        }
    };

    return (
        <SettingsPage name="general" deck="the directories the sesh picker walks · root is always indexed.">
            <SettingsSection
                code="[01]"
                title={
                    <>
                        project <b>roots</b>
                    </>
                }
                meta={`${projectRoots.length} ${projectRoots.length === 1 ? "entry" : "entries"}`}
                sub={
                    <>
                        root path is always walked · within <em>depth</em>, only git repos count
                    </>
                }>
                <div className="settings-row-input">
                    <input
                        ref={inputRef}
                        className="settings-input"
                        placeholder="~/proj    or    /Users/me/work"
                        value={draftPath}
                        onChange={(e) => setDraftPath(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                void commitDraft();
                            } else if (e.key === "Escape") {
                                cmd.closeSettings();
                            }
                        }}
                        spellCheck={false}
                    />
                    <DepthStepper value={draftDepth} onChange={setDraftDepth} title="Walk depth for this root" />
                    <button className="settings-btn" onClick={onPickFolder} type="button" title="Browse…">
                        <IconFolder size={11} /> browse
                    </button>
                    <button className="settings-btn primary" onClick={() => void commitDraft()} disabled={!draftPath.trim()} type="button">
                        <IconPlus size={11} /> add
                    </button>
                </div>

                {projectRoots.length === 0 ? (
                    <div className="settings-empty">
                        no roots — add <code>~/proj</code> (or wherever you keep code) to populate the sesh picker
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

function AppearancePage({ themeId, windowOpacity, windowBlur }: AppearancePageProps) {
    return (
        <SettingsPage name="appearance" deck="theme, window opacity & background blur · changes apply instantly.">
            <SettingsSection
                code="[01]"
                title={<b>theme</b>}
                meta={`${THEMES.length} installed · 1 active`}
                sub={
                    <>
                        applies <em>instantly</em> to chrome, editor, terminal · no reload
                    </>
                }>
                <div className="settings-theme-grid">
                    {THEMES.map((th) => {
                        const active = th.id === themeId;
                        return (
                            <button
                                key={th.id}
                                className={`settings-theme${active ? " active" : ""}`}
                                onClick={() => cmd.setThemeId(th.id)}
                                title={th.name}
                                type="button">
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
                        );
                    })}
                </div>
            </SettingsSection>

            <SettingsSection
                code="[02]"
                title={
                    <>
                        window · <b>opacity</b>
                    </>
                }
                meta="no cap"
                sub={
                    <>
                        <em>0.00</em> transparent · <em>1.00</em> opaque
                    </>
                }>
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

            <SettingsSection
                code="[03]"
                title={
                    <>
                        background · <b>blur</b>
                    </>
                }
                meta="CGS radius"
                sub={
                    <>
                        <em>0</em> none · <em>20–40</em> frosted · no cap
                    </>
                }>
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

interface CloudPageProps {
    cloudBrowser: string;
    cloudBrowserShortcut: string;
}

function CloudPage({ cloudBrowser, cloudBrowserShortcut }: CloudPageProps) {
    return (
        <SettingsPage name="cloud" deck="where AWS / GCP single-sign-on URLs open · which workspace to bounce to.">
            <SettingsSection
                code="[01]"
                title={
                    <>
                        sign-in <b>browser</b>
                    </>
                }
                meta="aws · gcp · sso"
                sub="where the SSO URL lands · pick the app you actually log in with">
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
                code="[02]"
                title={
                    <>
                        workspace <b>switch</b>
                    </>
                }
                meta="post-open · optional"
                sub="fired right after the link opens · point this at the desktop where the browser lives">
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
                <div className="settings-page-eyebrow">§ {name}</div>
                <h1 className="settings-page-hd">
                    {name}
                    <em>.</em>
                </h1>
                <p className="settings-page-deck">{deck}</p>
            </header>
            {children}
        </div>
    );
}

function SettingsSection({
    code,
    title,
    meta,
    sub,
    children,
}: {
    code: string;
    title: ReactNode;
    meta: ReactNode;
    sub: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="settings-section">
            <div className="settings-section-head">
                <div className="settings-section-code">{code}</div>
                <div className="settings-section-title-wrap">
                    <h2 className="settings-section-title">{title}</h2>
                    <div className="settings-section-dots"></div>
                </div>
                <div className="settings-section-meta">{meta}</div>
                <div className="settings-section-sub">{sub}</div>
            </div>
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
