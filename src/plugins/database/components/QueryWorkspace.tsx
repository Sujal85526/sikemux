import type { ReactNode } from "react";
import { swallow } from "../../../plugin-api/host";
import { Dropdown } from "../../../plugin-api/ui";
import type { DatabaseProfile, ResultSet } from "../api";
import { ROW_LIMITS, runQuery, stopQuery, updateQuery, useQuery } from "../queryState";
import { ResultsView } from "./ResultsView";
import { SqlEditor } from "./SqlEditor";

export function QueryWorkspace({ profile, resultActions }: { profile: DatabaseProfile; resultActions?: (result: ResultSet) => ReactNode }) {
    const query = useQuery(profile.id);
    const run = (sql: string) => void runQuery(profile.id, sql);

    return (
        <section className="db-workspace" aria-label={`Query ${profile.name}`}>
            <div className="db-toolbar">
                <button
                    type="button"
                    className="db-button primary"
                    disabled={query.running || !query.sql.trim()}
                    title="Run everything in the editor (⇧⌘↵). ⌘↵ in the editor runs the statement under the cursor."
                    onClick={() => run(query.sql)}>
                    {query.running ? "Running…" : "Run"}
                </button>
                {query.running && (
                    <button type="button" className="db-button danger" onClick={() => void stopQuery(profile.id).catch(swallow("stop the query"))}>
                        Stop
                    </button>
                )}
                <span className="db-meta">Rows</span>
                <Dropdown
                    label="Rows"
                    value={String(query.limit)}
                    title="The most rows kept from each statement"
                    options={ROW_LIMITS.map((limit) => ({ value: String(limit), label: limit.toLocaleString("en-US") }))}
                    onChange={(limit) => updateQuery(profile.id, { limit: Number(limit) })}
                />
                {profile.readOnly && <span className="db-badge">Read only</span>}
            </div>
            <SqlEditor value={query.sql} dialect={profile.engine} onChange={(sql) => updateQuery(profile.id, { sql })} onRun={run} />
            {query.error ? (
                <div className="db-query-error" role="alert">
                    <div className="db-callout" data-tone="danger">
                        {query.error}
                    </div>
                </div>
            ) : query.outcome ? (
                <ResultsView key={query.ran ?? ""} outcome={query.outcome} actions={resultActions} />
            ) : (
                <div className="db-results-empty">
                    {query.running ? "Running…" : "Write SQL above and press ⌘↵ to run the statement under the cursor."}
                </div>
            )}
        </section>
    );
}
