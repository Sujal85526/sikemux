import type { Slice } from "./types";

// UI-only state — modal flags, side rails, LSP results popup, the
// cross-component "please open this file" request bus.
export interface UiSlice {
  pickerOpen: boolean;
  agentPaletteOpen: boolean;
  leftRailOpen: boolean;
  rightRailOpen: boolean;
  home: string;
  agentFocusN: number;
  gitRefreshN: number;
  zoomedPaneId: string | null;
  lspResults: {
    title: string;
    project: string;
    results: { uri: string; line: number; character: number }[];
  } | null;
  openRequest: {
    path: string;
    line?: number;
    character?: number;
    n: number;
  } | null;

  setHome: (home: string) => void;
  openPicker: () => void;
  closePicker: () => void;
  openAgentPalette: () => void;
  closeAgentPalette: () => void;
  toggleLeftRail: () => void;
  toggleRightRail: () => void;
  openLspResults: (
    title: string,
    project: string,
    results: { uri: string; line: number; character: number }[],
  ) => void;
  closeLspResults: () => void;
  bumpGitRefresh: () => void;
  requestOpenFile: (path: string, line?: number, character?: number) => void;
}

export const createUiSlice: Slice<UiSlice> = (set) => ({
  pickerOpen: false,
  agentPaletteOpen: false,
  leftRailOpen: true,
  rightRailOpen: true,
  home: "",
  agentFocusN: 0,
  gitRefreshN: 0,
  zoomedPaneId: null,
  lspResults: null,
  openRequest: null,

  setHome: (home) => set({ home }),
  openPicker: () => set({ pickerOpen: true }),
  closePicker: () => set({ pickerOpen: false }),
  openAgentPalette: () => set({ agentPaletteOpen: true }),
  closeAgentPalette: () => set({ agentPaletteOpen: false }),
  toggleLeftRail: () => set((s) => ({ leftRailOpen: !s.leftRailOpen })),
  toggleRightRail: () => set((s) => ({ rightRailOpen: !s.rightRailOpen })),
  openLspResults: (title, project, results) =>
    set({ lspResults: { title, project, results } }),
  closeLspResults: () => set({ lspResults: null }),
  bumpGitRefresh: () => set((s) => ({ gitRefreshN: s.gitRefreshN + 1 })),
  requestOpenFile: (path, line, character) =>
    set((s) => ({
      zoomedPaneId: null,
      openRequest: { path, line, character, n: (s.openRequest?.n ?? 0) + 1 },
    })),
});
