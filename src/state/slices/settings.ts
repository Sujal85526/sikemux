import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_THEME_ID } from "../../themes";
import { applyTheme, applyWindowOpacity } from "../../themes/bus";
import type { Slice } from "./types";

export interface AppSettings {
  projectRoots: string[];
  themeId: string;
  windowOpacity: number;   // 0.4 .. 1.0  — CSS body opacity
  windowBlur: number;      // 0 .. 80     — CGS background blur radius
  /** Browser .app to open cloud SSO URLs in (empty = system default). */
  cloudBrowser: string;
  /** Optional keyboard shortcut fired before opening the URL, to land on
   *  the right browser workspace. e.g. "ctrl+3" for Zen workspace 3. */
  cloudBrowserShortcut: string;
  settingsOpen: boolean;
}

export interface SettingsSlice extends AppSettings {
  setThemeId: (id: string) => void;
  setWindowOpacity: (v: number) => void;
  setWindowBlur: (v: number) => void;
  setCloudBrowser: (v: string) => void;
  setCloudBrowserShortcut: (v: string) => void;
  addProjectRoot: (path: string) => void;
  removeProjectRoot: (path: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  toggleSettings: () => void;
}

export const DEFAULT_SETTINGS: AppSettings = {
  projectRoots: [],
  themeId: DEFAULT_THEME_ID,
  windowOpacity: 1,
  windowBlur: 0,
  cloudBrowser: "",
  cloudBrowserShortcut: "",
  settingsOpen: false,
};

export const createSettingsSlice: Slice<SettingsSlice> = (set) => ({
  ...DEFAULT_SETTINGS,

  setThemeId: (id) => {
    applyTheme(id);
    set({ themeId: id });
  },

  setWindowOpacity: (v) => {
    // No caps — user enters what they want. NaN guard only.
    const value = Number.isFinite(v) ? v : 1;
    applyWindowOpacity(value);
    set({ windowOpacity: value });
  },

  setWindowBlur: (v) => {
    const value = Number.isFinite(v) ? Math.round(v) : 0;
    invoke("set_window_blur", { radius: value }).catch(() => {});
    set({ windowBlur: value });
  },

  setCloudBrowser: (v) => set({ cloudBrowser: v.trim() }),
  setCloudBrowserShortcut: (v) => set({ cloudBrowserShortcut: v.trim() }),

  addProjectRoot: (path) =>
    set((s) =>
      s.projectRoots.includes(path)
        ? {}
        : { projectRoots: [...s.projectRoots, path] },
    ),

  removeProjectRoot: (path) =>
    set((s) => ({
      projectRoots: s.projectRoots.filter((p) => p !== path),
    })),

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
});
