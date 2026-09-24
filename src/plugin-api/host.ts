import { invokeCommand } from "../api/invoke";
import { subscribe } from "../state/bus";
import * as cmd from "../state/commands";
import { getState, setState, useStore, type StoreState } from "../state/store";
import type { PluginKind } from "../plugins/kinds";

export { git } from "../api/git";
export { gitOverviewR } from "../state/resources.defs";
export { usePluginOverlay } from "../plugins/overlays";
export { notify, reportError, swallow } from "../state/toast";

export function openUrl(url: string): Promise<void> {
    return invokeCommand<void>("open_url", { url, app: null, shortcut: null });
}

/** The folder of the project in front of the person, or null when a project is not what they are looking at. */
export function useActiveProjectCwd(): string | null {
    return useStore((s) => {
        const session = s.sessions[s.activeSessionId];
        return session?.kind === "project" && session.cwd ? session.cwd : null;
    });
}

function surfacePane(state: StoreState, kind: PluginKind, activeOnly: boolean): string | null {
    const session = activeOnly ? state.sessions[state.activeSessionId] : Object.values(state.sessions).find((s) => s.kind === kind);
    if (session?.kind !== kind) return null;
    return state.windows[session.activeWindowId]?.activePaneId ?? null;
}

/** The pane showing this surface, when its session is the one in front. */
export function useActiveSurfacePane(kind: PluginKind): string | null {
    return useStore((s) => surfacePane(s, kind, true));
}

/** Brings this surface's session forward, opening it if needed, and returns the pane it shows in. */
export function openSurface(kind: PluginKind): string | null {
    cmd.openPluginSession(kind);
    return surfacePane(getState(), kind, false);
}

export function onPaneClosed(listener: (paneId: string) => void): () => void {
    return subscribe("pane-closed", (event) => listener(event.paneId));
}

/** A plugin's palette and the app's own palettes are never open together. */
export function closeCorePalettes(): void {
    setState({ pickerOpen: false, filePaletteOpen: false, agentPaletteOpen: false });
}

export function useCorePaletteOpen(): boolean {
    return useStore((s) => s.pickerOpen || s.filePaletteOpen || s.agentPaletteOpen);
}
