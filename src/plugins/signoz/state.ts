import { create } from "zustand";
import { onPaneClosed, openSurface } from "../../plugin-api/host";
import { definePluginSettings } from "../../plugin-api/settings";
import type { Filter, Scope, TraceOrder } from "./api";
import { SIGNOZ_EXPLORE, SIGNOZ_PLUGIN_ID } from "./kinds";

export const WINDOWS = [5, 15, 60, 360, 1440] as const;
export const SEVERITIES = ["FATAL", "ERROR", "WARN", "INFO", "DEBUG"] as const;
export const SERVICE_SORTS = ["errors", "calls", "p99", "name"] as const;
export type ServiceSort = (typeof SERVICE_SORTS)[number];

export interface SignozSettings {
    minutes: number;
    /** Which deployment.environment every view reads, or all of them. */
    environment: string | null;
    serviceSort: ServiceSort;
    /** The service each project folder reports as, when it is not the folder's own name. */
    serviceByProject: Record<string, string>;
    /** The values chosen for each dashboard's variables, by dashboard id. */
    dashboardVariables: Record<string, Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function decodeSettings(saved: unknown): SignozSettings {
    const raw = isRecord(saved) ? saved : {};
    const serviceByProject: Record<string, string> = {};
    for (const [cwd, service] of Object.entries(isRecord(raw.serviceByProject) ? raw.serviceByProject : {})) {
        if (typeof service === "string" && service) serviceByProject[cwd] = service;
    }
    const dashboardVariables: Record<string, Record<string, string>> = {};
    for (const [id, values] of Object.entries(isRecord(raw.dashboardVariables) ? raw.dashboardVariables : {})) {
        if (!isRecord(values)) continue;
        dashboardVariables[id] = Object.fromEntries(
            Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
    }
    return {
        dashboardVariables,
        minutes: typeof raw.minutes === "number" && (WINDOWS as readonly number[]).includes(raw.minutes) ? raw.minutes : 15,
        environment: typeof raw.environment === "string" && raw.environment ? raw.environment : null,
        serviceSort: (SERVICE_SORTS as readonly unknown[]).includes(raw.serviceSort) ? (raw.serviceSort as ServiceSort) : "errors",
        serviceByProject,
    };
}

export const signozSettings = definePluginSettings(SIGNOZ_PLUGIN_ID, decodeSettings);

export function updateSettings(patch: Partial<SignozSettings>): void {
    signozSettings.update((settings) => ({ ...settings, ...patch }));
}

export type ExploreTab = "logs" | "traces";

export interface TimeRange {
    start: number;
    end: number;
}

export interface ExploreView {
    tab: ExploreTab;
    service: string | null;
    filters: Filter[];
    severities: string[];
    text: string;
    expression: string;
    /** Following new data as it arrives, or holding still on a window that ends at `fixedEnd`. */
    live: boolean;
    fixedEnd: number | null;
    trace: string | null;
    /** A dashboard shown in place of logs and traces. */
    dashboard: string | null;
    /** A moment picked out of a chart, which holds the view still on it. */
    range: TimeRange | null;
    traceOrder: TraceOrder;
    tracesErrorsOnly: boolean;
}

const FRESH: ExploreView = {
    tab: "logs",
    service: null,
    filters: [],
    severities: ["FATAL", "ERROR"],
    text: "",
    expression: "",
    live: true,
    fixedEnd: null,
    trace: null,
    dashboard: null,
    range: null,
    traceOrder: "slowest",
    tracesErrorsOnly: false,
};

export const useSignoz = create<{ views: Record<string, ExploreView>; paletteOpen: boolean }>()(() => ({ views: {}, paletteOpen: false }));

export function togglePalette(): void {
    useSignoz.setState((state) => ({ paletteOpen: !state.paletteOpen }));
}

export function closePalette(): void {
    useSignoz.setState({ paletteOpen: false });
}

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

export function viewOf(paneId: string): ExploreView {
    return useSignoz.getState().views[paneId] ?? FRESH;
}

export function updateView(paneId: string, patch: Partial<ExploreView>): void {
    useSignoz.setState((state) => ({ views: { ...state.views, [paneId]: { ...(state.views[paneId] ?? FRESH), ...patch } } }));
}

/** One filter per attribute and operator: saying it again replaces it rather than stacking a copy. */
export function addFilter(paneId: string, filter: Filter): void {
    const others = viewOf(paneId).filters.filter((existing) => existing.key !== filter.key || existing.op !== filter.op);
    updateView(paneId, { filters: [...others, filter], trace: null });
}

export function removeFilter(paneId: string, index: number): void {
    updateView(paneId, { filters: viewOf(paneId).filters.filter((_, position) => position !== index) });
}

export function setLive(paneId: string, live: boolean): void {
    updateView(paneId, { live, fixedEnd: live ? null : Date.now(), range: null });
}

export function zoomTo(paneId: string, range: TimeRange): void {
    updateView(paneId, { live: false, range, fixedEnd: range.end });
}

export function openDashboard(paneId: string, dashboard: string | null): void {
    updateView(paneId, { dashboard, trace: null });
}

export function setDashboardVariable(dashboard: string, name: string, value: string): void {
    signozSettings.update((settings) => ({
        ...settings,
        dashboardVariables: { ...settings.dashboardVariables, [dashboard]: { ...settings.dashboardVariables[dashboard], [name]: value } },
    }));
}

/** What the view narrows every query by, in the shape the backend reads. */
export function scopeOf(view: ExploreView, settings: Pick<SignozSettings, "minutes" | "environment">): Scope {
    const range = view.range
        ? { start: view.range.start, end: view.range.end }
        : view.live || view.fixedEnd === null
          ? { minutes: settings.minutes }
          : { start: view.fixedEnd - settings.minutes * 60_000, end: view.fixedEnd };
    return {
        ...range,
        service: view.service ?? undefined,
        environment: settings.environment ?? undefined,
        filters: view.filters,
        expression: view.expression.trim() || undefined,
    };
}

export function openSignoz(): void {
    openSurface(SIGNOZ_EXPLORE);
}

/** Brings SigNoz forward on one trace, from anywhere that has its id. */
export function openTrace(traceId: string): void {
    const paneId = openSurface(SIGNOZ_EXPLORE);
    if (paneId) updateView(paneId, { trace: traceId });
}

export function openService(service: string): void {
    const paneId = openSurface(SIGNOZ_EXPLORE);
    if (paneId) updateView(paneId, { service, trace: null, dashboard: null });
}
