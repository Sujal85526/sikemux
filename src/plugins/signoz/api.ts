import { createPluginBackend, isPluginFailure } from "../../plugin-api/backend";
import { invalidate } from "../../plugin-api/resources";
import { SIGNOZ_PLUGIN_ID } from "./kinds";

const backend = createPluginBackend(SIGNOZ_PLUGIN_ID);

export type AuthMode = "session" | "apiKey";

export interface SignozStatus {
    configured: boolean;
    url: string;
    auth: AuthMode;
    email: string;
    keyFromEnvironment: boolean;
    version: string | null;
    ok: boolean;
    authFailed: boolean;
    message: string | null;
}

export interface SsoProvider {
    provider: string;
    url: string;
}

export interface OrgSignIn {
    id: string;
    name: string;
    password: boolean;
    sso: SsoProvider[];
}

export interface Inspection {
    url: string;
    version: string | null;
    accountExists: boolean | null;
    orgs: OrgSignIn[];
}

export interface LogLine {
    id: string;
    timestamp: string;
    service: string | null;
    severity: string | null;
    body: string;
    traceId: string | null;
    spanId: string | null;
    attributes: Record<string, unknown>;
    resources: Record<string, unknown>;
}

export interface LogSearch {
    text?: string;
    service?: string;
    severities?: string[];
    traceId?: string;
    expression?: string;
    minutes?: number;
    limit?: number;
    offset?: number;
}

export interface LogPage {
    lines: LogLine[];
    nextOffset: number | null;
}

export interface TailTick {
    lines: LogLine[];
    error: string | null;
}

export interface ServiceHealth {
    service: string;
    calls: number;
    errors: number;
    errorRate: number;
    p99Ms: number;
}

export interface TraceSpan {
    spanId: string;
    parentId: string | null;
    name: string;
    service: string;
    depth: number;
    offsetMs: number;
    durationMs: number;
    error: boolean;
    status: string | null;
    kind: string | null;
}

export interface Trace {
    traceId: string;
    start: string;
    durationMs: number;
    errorCount: number;
    services: string[];
    spans: TraceSpan[];
    truncated: boolean;
}

export function failureMessage(error: unknown): string {
    return isPluginFailure(error) ? error.message : String(error);
}

function isSignedOut(error: unknown): boolean {
    if (!isPluginFailure(error)) return false;
    return (
        error.category === "auth" ||
        error.category === "unconfigured" ||
        (error.category === "http" && (error.status === 401 || error.status === 403))
    );
}

/** A lapsed session makes every cached answer stale, so the next read lands on the sign-in form. */
async function read<T>(method: string, params?: unknown): Promise<T> {
    try {
        return await backend.call<T>(method, params);
    } catch (error) {
        if (isSignedOut(error)) invalidate((kind) => kind.startsWith("signoz."));
        throw error;
    }
}

export const signozApi = {
    status: () => backend.call<SignozStatus>("status"),
    inspect: (url: string, email?: string) => backend.call<Inspection>("inspect", { url, email }),
    signIn: (url: string, email: string, password: string, orgId?: string) => backend.call<SignozStatus>("signIn", { url, email, password, orgId }),
    useApiKey: (url: string, apiKey?: string, account?: string) => backend.call<SignozStatus>("useApiKey", { url, apiKey, account }),
    signOut: () => backend.call<void>("signOut"),

    services: (minutes: number) => read<ServiceHealth[]>("services", { minutes }),
    searchLogs: (search: LogSearch) => read<LogPage>("searchLogs", search),
    trace: (traceId: string) => read<Trace>("trace", { traceId }),

    tailStart: (search: LogSearch, onTick: (tick: TailTick) => void) => backend.openStream<TailTick>("tailLogs", search, onTick),
    tailStop: (id: number) => backend.closeStream(id),
};
