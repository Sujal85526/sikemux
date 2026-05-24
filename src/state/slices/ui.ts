import type { Slice } from "./types";

export type PickerMode = "all" | "projects" | "ssh";

// UI-only state — modal flags, side rails, LSP results popup, the
// cross-component "please open this file" request bus.
export interface UiSlice {
  pickerOpen: boolean;
  pickerMode: PickerMode;
  agentPaletteOpen: boolean;
  filePaletteOpen: boolean;
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
  openPicker: (mode?: PickerMode) => void;
  closePicker: () => void;
  openAgentPalette: () => void;
  closeAgentPalette: () => void;
  openFilePalette: () => void;
  closeFilePalette: () => void;
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
  pickerMode: "all",
  agentPaletteOpen: false,
  filePaletteOpen: false,
  leftRailOpen: true,
  rightRailOpen: true,
  home: "",
  agentFocusN: 0,
  gitRefreshN: 0,
  zoomedPaneId: null,
  lspResults: null,
  openRequest: null,

  setHome: (home) => set({ home }),
  // Open the sesh picker in a specific mode (defaults to "all"). Mode
  // controls which sources the picker pulls from — projects/command
  // sessions, project roots, ssh hosts. See SeshPicker.
  openPicker: (mode = "all") => set({ pickerOpen: true, pickerMode: mode }),
  closePicker: () => set({ pickerOpen: false }),
  openAgentPalette: () => set({ agentPaletteOpen: true }),
  closeAgentPalette: () => set({ agentPaletteOpen: false }),
  openFilePalette: () => set({ filePaletteOpen: true }),
  closeFilePalette: () => set({ filePaletteOpen: false }),
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
