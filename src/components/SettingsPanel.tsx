import { useEffect, useRef, useState } from "react";
import { settingsApi } from "../api/settings";
import { reportError } from "../state/toast";
import { useWorkspace } from "../state/workspace";
import { THEMES } from "../themes";
import { IconClose, IconFolder, IconPlus } from "./Icons";

// Cmd-, settings. Sectioned single-scroll modal, sharp corners, tight TUI
// density. Each section pairs a label (left, tracked uppercase) with a short
// hint on the right.
export function SettingsPanel() {
  const close = useWorkspace((s) => s.closeSettings);
  const projectRoots = useWorkspace((s) => s.projectRoots);
  const addProjectRoot = useWorkspace((s) => s.addProjectRoot);
  const removeProjectRoot = useWorkspace((s) => s.removeProjectRoot);
  const themeId = useWorkspace((s) => s.themeId);
  const setThemeId = useWorkspace((s) => s.setThemeId);
  const windowOpacity = useWorkspace((s) => s.windowOpacity);
  const setWindowOpacity = useWorkspace((s) => s.setWindowOpacity);
  const windowBlur = useWorkspace((s) => s.windowBlur);
  const setWindowBlur = useWorkspace((s) => s.setWindowBlur);
  const cloudBrowser = useWorkspace((s) => s.cloudBrowser);
  const setCloudBrowser = useWorkspace((s) => s.setCloudBrowser);
  const cloudBrowserShortcut = useWorkspace((s) => s.cloudBrowserShortcut);
  const setCloudBrowserShortcut = useWorkspace((s) => s.setCloudBrowserShortcut);
  const home = useWorkspace((s) => s.home);

  const [draftPath, setDraftPath] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pretty = (p: string) =>
    home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;

  const commitDraft = async () => {
    const raw = draftPath.trim();
    if (!raw) return;
    try {
      const expanded = await settingsApi.expandPath(raw);
      addProjectRoot(expanded);
      setDraftPath("");
    } catch (err) {
      reportError("settings")(err);
    }
  };

  const onPickFolder = async () => {
    try {
      const picked = await settingsApi.pickFolder(home || undefined);
      if (picked) addProjectRoot(picked);
    } catch (err) {
      reportError("folder picker")(err);
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={close}>
      <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span className="settings-title">
            <strong>·</strong>settings
          </span>
          <span className="settings-kbd">⌘,</span>
          <button
            className="settings-close"
            onClick={close}
            title="Close (Esc / ⌘,)"
          >
            <IconClose size={11} />
          </button>
        </div>

        <div className="settings-scroll">
          {/* ---- Project roots ---- */}
          <section className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-title">Project roots</span>
              <span className="settings-section-sub">
                each root + its immediate subdirs become projects
              </span>
            </div>

            <div className="settings-add-row">
              <input
                ref={inputRef}
                className="settings-input"
                placeholder="~/proj  or  /Users/me/work"
                value={draftPath}
                onChange={(e) => setDraftPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitDraft();
                  } else if (e.key === "Escape") {
                    close();
                  }
                }}
                spellCheck={false}
              />
              <button
                className="settings-btn"
                onClick={onPickFolder}
                title="Browse…"
              >
                <IconFolder size={11} />
                Browse
              </button>
              <button
                className="settings-btn primary"
                onClick={() => void commitDraft()}
                disabled={!draftPath.trim()}
              >
                <IconPlus size={11} />
                Add
              </button>
            </div>

            {projectRoots.length === 0 ? (
              <div className="settings-empty">
                no roots — add <code>~/proj</code> (or wherever you keep code) to populate the sesh picker
              </div>
            ) : (
              <div className="settings-list">
                {projectRoots.map((path) => (
                  <div className="settings-row" key={path}>
                    <span className="settings-row-icon">
                      <IconFolder size={12} />
                    </span>
                    <span className="settings-row-path">{pretty(path)}</span>
                    <button
                      className="settings-row-x"
                      onClick={() => removeProjectRoot(path)}
                      title="Remove"
                    >
                      <IconClose size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ---- Theme ---- */}
          <section className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-title">Theme</span>
              <span className="settings-section-sub">
                applies instantly · chrome, editor, terminal
              </span>
            </div>
            <div className="theme-grid">
              {THEMES.map((th) => {
                const active = th.id === themeId;
                return (
                  <button
                    key={th.id}
                    className={`theme-card${active ? " active" : ""}`}
                    onClick={() => setThemeId(th.id)}
                    title={th.name}
                  >
                    <div className="theme-card-swatches">
                      <span style={{ background: th.terminal.red }} />
                      <span style={{ background: th.terminal.green }} />
                      <span style={{ background: th.terminal.yellow }} />
                      <span style={{ background: th.terminal.blue }} />
                      <span style={{ background: th.terminal.magenta }} />
                      <span style={{ background: th.terminal.cyan }} />
                    </div>
                    <span className="theme-card-name">{th.name}</span>
                    {active && <span className="theme-card-check">on</span>}
                  </button>
                );
              })}
            </div>
          </section>

          {/* ---- Window opacity ---- */}
          <section className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-title">Window opacity</span>
              <span className="settings-section-sub">
                0.00 transparent · 1.00 opaque · no cap
              </span>
            </div>
            <NumberField
              value={windowOpacity}
              onCommit={setWindowOpacity}
              format={(v) => v.toFixed(2)}
              suffix="opacity"
            />
          </section>

          {/* ---- Window blur ---- */}
          <section className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-title">Background blur</span>
              <span className="settings-section-sub">
                CGS radius · 0 none · 20–40 frosted · no cap
              </span>
            </div>
            <NumberField
              value={windowBlur}
              onCommit={(v) => setWindowBlur(Math.round(v))}
              format={(v) => String(Math.round(v))}
              suffix="px"
            />
          </section>

          {/* ---- Cloud (browser routing for AWS/GCP sign-in) ---- */}
          <section className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-title">Cloud sign-in</span>
              <span className="settings-section-sub">
                where SSO URLs open · landing space
              </span>
            </div>
            <div className="settings-add-row">
              <input
                className="settings-input"
                placeholder="Browser app name (e.g. Zen, Arc, Safari · empty = system default)"
                value={cloudBrowser}
                onChange={(e) => setCloudBrowser(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="settings-add-row">
              <input
                className="settings-input"
                placeholder="Workspace shortcut (e.g. ctrl+3 · empty = no switch)"
                value={cloudBrowserShortcut}
                onChange={(e) => setCloudBrowserShortcut(e.target.value)}
                spellCheck={false}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ---- NumberField -------------------------------------------------------
// Text input that buffers user typing and only commits a numeric value on
// blur or Enter. No min/max — whatever the user types goes through.

interface NumberFieldProps {
  value: number;
  onCommit: (v: number) => void;
  format: (v: number) => string;
  suffix?: string;
}

function NumberField({ value, onCommit, format, suffix }: NumberFieldProps) {
  const [draft, setDraft] = useState<string>(() => format(value));
  const focusedRef = useRef(false);

  // Sync external value into the input unless the user is actively typing.
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
    <div className="settings-number-row">
      <input
        type="text"
        inputMode="decimal"
        className="settings-number-input"
        value={draft}
        spellCheck={false}
        onFocus={() => { focusedRef.current = true; }}
        onBlur={() => { focusedRef.current = false; commit(); }}
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
      {suffix && <span className="settings-number-suffix">{suffix}</span>}
    </div>
  );
}
