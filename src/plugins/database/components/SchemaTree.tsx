import { useState } from "react";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { Dropdown, SkeletonRows } from "../../../plugin-api/ui";
import type { DatabaseProfile, TableKind } from "../api";
import { defaultSchema } from "../profileForm";
import { databaseSchemasR, databaseTablesR } from "../resources";
import type { OpenTable } from "../state";

const KIND_LABEL: Record<TableKind, string> = {
    table: "table",
    view: "view",
    "materialized-view": "materialized view",
    "foreign-table": "foreign table",
};

export function SchemaTree({
    profile,
    active,
    schema,
    table,
    onSchema,
    onOpen,
}: {
    profile: DatabaseProfile;
    active: boolean;
    /** The schema picked; null for the database's usual one. */
    schema: string | null;
    table: OpenTable | null;
    onSchema: (schema: string) => void;
    onOpen: (table: OpenTable) => void;
}) {
    const [filter, setFilter] = useState("");
    const schemas = useResourceEnabled(active, databaseSchemasR, profile.id);
    const shown = schema ?? defaultSchema(profile);
    const tables = useResourceEnabled(active && !!shown, databaseTablesR, profile.id, shown);
    const words = filter.trim().toLowerCase();
    const matching = (tables.data ?? []).filter((each) => each.name.toLowerCase().includes(words));

    return (
        <div className="db-tree" aria-label={`Tables in ${profile.name}`}>
            {(schemas.data?.length ?? 0) > 1 && (
                <Dropdown
                    label="Schema"
                    value={shown}
                    options={(schemas.data ?? []).map((name) => ({ value: name, label: name }))}
                    onChange={onSchema}
                    search="Find a schema"
                />
            )}
            <input
                className="db-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter tables"
                aria-label="Filter tables"
                spellCheck={false}
            />
            {!shown ? (
                <div className="db-hint">This connection names no database. Pick a schema above.</div>
            ) : tables.status === "error" ? (
                <div className="db-hint" role="alert">
                    {tables.error}
                </div>
            ) : !tables.data ? (
                <SkeletonRows rows={4} label="Loading tables" />
            ) : matching.length === 0 ? (
                <div className="db-hint">{words ? "No table matches." : "No tables here yet."}</div>
            ) : (
                <ul className="db-tables">
                    {matching.map((each) => {
                        const open = table?.schema === shown && table.name === each.name;
                        return (
                            <li key={each.name}>
                                <button
                                    type="button"
                                    className={`db-table${open ? " active" : ""}`}
                                    title={`${shown}.${each.name}, a ${KIND_LABEL[each.kind]}`}
                                    onClick={() => onOpen({ schema: shown, name: each.name })}>
                                    <span className={`db-table-kind ${each.kind}`} aria-hidden="true">
                                        {each.kind === "table" ? "▦" : "◇"}
                                    </span>
                                    <span className="db-table-name">{each.name}</span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
