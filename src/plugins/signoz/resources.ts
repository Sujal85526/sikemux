import { resource } from "../../plugin-api/resources";
import {
    signozApi,
    type Dashboard,
    type DashboardSummary,
    type PanelData,
    type PanelRequest,
    type VolumeBucket,
    type FieldKey,
    type LogPage,
    type LogSearch,
    type Scope,
    type ServiceHealth,
    type Signal,
    type SignozStatus,
    type Trace,
    type TracePage,
    type TraceSearch,
} from "./api";

export const signozStatusR = resource({
    kind: "signoz.status",
    fetch: (): Promise<SignozStatus> => signozApi.status(),
    staleAfterMs: 60_000,
});

export const signozServicesR = resource({
    kind: "signoz.services",
    fetch: (scope: Scope): Promise<ServiceHealth[]> => signozApi.services(scope),
    staleAfterMs: 30_000,
});

export const signozTracesR = resource({
    kind: "signoz.traces",
    fetch: (search: TraceSearch): Promise<TracePage> => signozApi.searchTraces(search),
    staleAfterMs: 30_000,
});

export const signozTraceR = resource({
    kind: "signoz.trace",
    fetch: (traceId: string): Promise<Trace> => signozApi.trace(traceId),
    staleAfterMs: 5 * 60_000,
});

export const signozTraceLogsR = resource({
    kind: "signoz.traceLogs",
    fetch: (search: LogSearch): Promise<LogPage> => signozApi.searchLogs(search),
    staleAfterMs: 60_000,
});

export const signozFieldKeysR = resource({
    kind: "signoz.fieldKeys",
    fetch: (signal: Signal, search: string): Promise<FieldKey[]> => signozApi.fieldKeys(signal, search),
    staleAfterMs: 5 * 60_000,
});

export const signozFieldValuesR = resource({
    kind: "signoz.fieldValues",
    fetch: (signal: Signal, name: string, search: string): Promise<string[]> => signozApi.fieldValues(signal, name, search),
    staleAfterMs: 60_000,
});

export const signozVolumeR = resource({
    kind: "signoz.volume",
    fetch: (search: LogSearch & { buckets?: number }): Promise<VolumeBucket[]> => signozApi.logVolume(search),
    staleAfterMs: 15_000,
});

export const signozDashboardsR = resource({
    kind: "signoz.dashboards",
    fetch: (): Promise<DashboardSummary[]> => signozApi.dashboards(),
    staleAfterMs: 5 * 60_000,
});

export const signozDashboardR = resource({
    kind: "signoz.dashboard",
    fetch: (id: string): Promise<Dashboard> => signozApi.dashboard(id),
    staleAfterMs: 5 * 60_000,
});

export const signozPanelR = resource({
    kind: "signoz.panel",
    fetch: (request: PanelRequest): Promise<PanelData> => signozApi.panel(request),
    staleAfterMs: 30_000,
});
