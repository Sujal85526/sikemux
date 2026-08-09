import type { AgentInfo, AgentSession, AgentSessionProviderResult } from "./api/agents";
import { rankBy } from "./lib/fuzzy";
import type { AgentType } from "./state/types";

export type AgentChatLoadPhase = "detecting" | "history-loading" | "ready" | "partial-error" | "empty";

export interface AgentChatRow {
    /** Collision-safe identity for keyed UI lists. */
    key: string;
    /** Provider transcript id passed to the provider's resume command. */
    id: string;
    /** Kept as `type` to match the existing agent launch command surface. */
    type: AgentType;
    providerLabel: string;
    title: string;
    mtime: number;
    cwd: string;
}

export type AgentChatProviderLoad = { provider: AgentInfo; status: "loading" } | AgentSessionProviderResult;

export interface AgentChatProviderError {
    type: AgentType;
    label: string;
}

export interface AgentChatLoadSummary {
    phase: AgentChatLoadPhase;
    rows: AgentChatRow[];
    providerCount: number;
    loadingProviderCount: number;
    successfulProviderCount: number;
    failedProviderCount: number;
    /** Safe display metadata only; provider exceptions never reach the view model. */
    providerErrors: AgentChatProviderError[];
    detectionFailed: boolean;
}

function cleanText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function finiteMtime(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function agentChatKey(type: AgentType, id: string, cwd: string): string {
    return JSON.stringify([type, id, cwd]);
}

export function normalizeAgentChat(provider: Pick<AgentInfo, "type" | "label">, session: AgentSession, cwd: string): AgentChatRow {
    const id = session.id.trim();
    const providerLabel = cleanText(provider.label) || provider.type;
    return {
        key: agentChatKey(provider.type, id, cwd),
        id,
        type: provider.type,
        providerLabel,
        title: cleanText(session.title) || "Untitled chat",
        mtime: finiteMtime(session.mtime),
        cwd,
    };
}

/**
 * Sort newest first while preserving input order for equal timestamps. Explicit
 * decoration makes that guarantee independent of the JavaScript runtime sort.
 */
export function sortAgentChatsByRecent(rows: readonly AgentChatRow[]): AgentChatRow[] {
    return rows
        .map((row, index) => ({ row, index }))
        .sort((left, right) => right.row.mtime - left.row.mtime || left.index - right.index)
        .map(({ row }) => row);
}

/** Normalize, de-duplicate per provider/session/workspace, and order by recency. */
export function normalizeAgentChats(histories: readonly Extract<AgentChatProviderLoad, { status: "success" }>[], cwd: string): AgentChatRow[] {
    const rows = new Map<string, AgentChatRow>();
    for (const history of histories) {
        for (const session of history.sessions) {
            const row = normalizeAgentChat(history.provider, session, cwd);
            if (!row.id) continue;
            const current = rows.get(row.key);
            if (!current || row.mtime > current.mtime) rows.set(row.key, row);
        }
    }
    return sortAgentChatsByRecent([...rows.values()]);
}

/** Ordered fields used by the launcher fuzzy matcher and assistive descriptions. */
export function agentChatSearchFields(row: AgentChatRow): string[] {
    return [row.title, row.providerLabel, row.type, row.id, row.cwd];
}

export function agentChatSearchCorpus(row: AgentChatRow): string {
    return agentChatSearchFields(row).join(" ");
}

/** Blank queries are guaranteed to return the stable recent order. */
export function searchAgentChats(rows: readonly AgentChatRow[], query: string): AgentChatRow[] {
    const recent = sortAgentChatsByRecent(rows);
    return rankBy(query, recent, (row) => [agentChatSearchCorpus(row), ...agentChatSearchFields(row)]);
}

export function aggregateAgentChatLoadState(input: {
    detecting: boolean;
    detectionFailed?: boolean;
    cwd: string;
    providers: readonly AgentChatProviderLoad[];
}): AgentChatLoadSummary {
    const successful = input.providers.filter(
        (provider): provider is Extract<AgentChatProviderLoad, { status: "success" }> => provider.status === "success",
    );
    const loadingProviderCount = input.providers.filter((provider) => provider.status === "loading").length;
    const providerErrors = input.providers
        .filter((provider): provider is Extract<AgentChatProviderLoad, { status: "error" }> => provider.status === "error")
        .map(({ provider }) => ({ type: provider.type, label: cleanText(provider.label) || provider.type }));
    const rows = normalizeAgentChats(successful, input.cwd);
    const detectionFailed = input.detectionFailed === true;

    let phase: AgentChatLoadPhase;
    if (input.detecting) phase = "detecting";
    else if (loadingProviderCount > 0) phase = "history-loading";
    else if (detectionFailed || providerErrors.length > 0) phase = "partial-error";
    else if (rows.length > 0) phase = "ready";
    else phase = "empty";

    return {
        phase,
        rows,
        providerCount: input.providers.length,
        loadingProviderCount,
        successfulProviderCount: successful.length,
        failedProviderCount: providerErrors.length,
        providerErrors,
        detectionFailed,
    };
}

/** Combine independently loading checkout histories into one project view. */
export function mergeAgentChatLoadSummaries(summaries: readonly AgentChatLoadSummary[]): AgentChatLoadSummary {
    const rows = sortAgentChatsByRecent([...new Map(summaries.flatMap((summary) => summary.rows).map((row) => [row.key, row])).values()]);
    const detectionFailed = summaries.some((summary) => summary.detectionFailed);
    const loadingProviderCount = summaries.reduce((total, summary) => total + summary.loadingProviderCount, 0);
    const failedProviderCount = summaries.reduce((total, summary) => total + summary.failedProviderCount, 0);
    let phase: AgentChatLoadPhase;
    if (summaries.some((summary) => summary.phase === "detecting")) phase = "detecting";
    else if (loadingProviderCount > 0) phase = "history-loading";
    else if (detectionFailed || failedProviderCount > 0) phase = "partial-error";
    else if (rows.length > 0) phase = "ready";
    else phase = "empty";
    return {
        phase,
        rows,
        providerCount: summaries.reduce((total, summary) => total + summary.providerCount, 0),
        loadingProviderCount,
        successfulProviderCount: summaries.reduce((total, summary) => total + summary.successfulProviderCount, 0),
        failedProviderCount,
        providerErrors: summaries.flatMap((summary) => summary.providerErrors),
        detectionFailed,
    };
}
