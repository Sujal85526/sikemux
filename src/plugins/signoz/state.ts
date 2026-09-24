import { create } from "zustand";
import { onPaneClosed, openSurface } from "../../plugin-api/host";
import { definePluginSettings } from "../../plugin-api/settings";
import { SIGNOZ_EXPLORE, SIGNOZ_PLUGIN_ID } from "./kinds";

export const WINDOWS = [5, 15, 60, 360, 1440] as const;

export interface SignozSettings {
    minutes: number;
    /** The service each project folder reports as, when it is not the folder's own name. */
    serviceByProject: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function decodeSettings(saved: unknown): SignozSettings {
    const raw = isRecord(saved) ? saved : {};
    const serviceByProject: Record<string, string> = {};
    for (const [cwd, service] of Object.entries(isRecord(raw.serviceByProject) ? raw.serviceByProject : {})) {
        if (typeof service === "string" && service) serviceByProject[cwd] = service;
    }
    const minutes = typeof raw.minutes === "number" && (WINDOWS as readonly number[]).includes(raw.minutes) ? raw.minutes : 15;
    return { minutes, serviceByProject };
}

export const signozSettings = definePluginSettings(SIGNOZ_PLUGIN_ID, decodeSettings);

export function setWindow(minutes: number): void {
    signozSettings.update((settings) => ({ ...settings, minutes }));
}

export interface ExploreView {
    service: string | null;
    text: string;
    errorsOnly: boolean;
    trace: string | null;
}

const FRESH: ExploreView = { service: null, text: "", errorsOnly: true, trace: null };

export const useSignoz = create<{ views: Record<string, ExploreView> }>()(() => ({ views: {} }));

onPaneClosed((paneId) => {
    if (!(paneId in useSignoz.getState().views)) return;
    useSignoz.setState((state) => {
        const views = { ...state.views };
        delete views[paneId];
        return { views };
    });
});

export function useExploreView(paneId: string): ExploreView {
    return useSignoz((state) => state.views[paneId] ?? FRESH);
}

export function updateView(paneId: string, patch: Partial<ExploreView>): void {
    useSignoz.setState((state) => ({ views: { ...state.views, [paneId]: { ...(state.views[paneId] ?? FRESH), ...patch } } }));
}

export function openSignoz(): void {
    openSurface(SIGNOZ_EXPLORE);
}

/** Brings SigNoz forward on one trace, from anywhere that has its id. */
export function openTrace(traceId: string): void {
    const paneId = openSurface(SIGNOZ_EXPLORE);
    if (paneId) updateView(paneId, { trace: traceId });
}
