import { resource } from "../../plugin-api/resources";
import { signozApi, type LogPage, type LogSearch, type ServiceHealth, type SignozStatus, type Trace } from "./api";

export const signozStatusR = resource({
    kind: "signoz.status",
    fetch: (): Promise<SignozStatus> => signozApi.status(),
    staleAfterMs: 60_000,
});

export const signozServicesR = resource({
    kind: "signoz.services",
    fetch: (minutes: number): Promise<ServiceHealth[]> => signozApi.services(minutes),
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
