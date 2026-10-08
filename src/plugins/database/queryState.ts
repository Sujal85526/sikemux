import { create } from "zustand";
import { invalidate } from "../../plugin-api/resources";
import { databaseApi, failureMessage, type QueryOutcome } from "./api";

export const ROW_LIMITS = [100, 500, 1000, 5000] as const;
export const DEFAULT_ROW_LIMIT = 500;

/** One console's query: the SQL being written, and what the last run gave. */
export interface QueryState {
    sql: string;
    limit: number;
    running: boolean;
    outcome: QueryOutcome | null;
    error: string | null;
    /** The SQL of the last run, shown beside its outcome. */
    ran: string | null;
}

const EMPTY: QueryState = { sql: "", limit: DEFAULT_ROW_LIMIT, running: false, outcome: null, error: null, ran: null };

const useQueries = create<{ queries: Record<string, QueryState> }>(() => ({ queries: {} }));

export const useQuery = (id: string): QueryState => useQueries((state) => state.queries[id] ?? EMPTY);

export const readQuery = (id: string): QueryState => useQueries.getState().queries[id] ?? EMPTY;

export function updateQuery(id: string, change: Partial<QueryState>): void {
    useQueries.setState((state) => ({ queries: { ...state.queries, [id]: { ...(state.queries[id] ?? EMPTY), ...change } } }));
}

/** Runs the console's SQL on a saved database. A run already going is left alone rather than queued. */
export async function runQuery(id: string, profile: string, sql: string): Promise<void> {
    const text = sql.trim();
    if (!text || readQuery(id).running) return;
    updateQuery(id, { running: true, error: null, ran: text });
    try {
        const outcome = await databaseApi.query(profile, text, readQuery(id).limit);
        updateQuery(id, { outcome, error: null });
    } catch (failure) {
        updateQuery(id, { outcome: null, error: failureMessage(failure) });
    } finally {
        updateQuery(id, { running: false });
        invalidate((kind) => kind === "database.history" || kind === "database.connected");
    }
}

export async function stopQuery(profile: string): Promise<void> {
    await databaseApi.cancel(profile);
}

/** Puts SQL in the editor without running it, as when a table or a past query is picked. */
export function loadQuery(id: string, sql: string): void {
    updateQuery(id, { sql });
}

/** Forgets a console's query, as when its tab closes. */
export function forgetQuery(id: string): void {
    useQueries.setState((state) => {
        const queries = { ...state.queries };
        delete queries[id];
        return { queries };
    });
}
