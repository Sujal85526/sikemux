import { swallow } from "../../../plugin-api/host";
import { databaseApi, refreshDatabase, type Connected, type DatabaseProfile } from "../api";
import { loadQuery, runQuery, useQuery } from "../queryState";
import type { DatabaseView, OpenTable } from "../state";
import { HistoryPanel } from "./HistoryPanel";
import { QueryWorkspace } from "./QueryWorkspace";
import { SendResults } from "./SendResults";
import { TableView } from "./TableView";

/** An open database: its query, the table picked in the sidebar, and its history, a tab each. */
export function ConnectedDatabase({
    profile,
    connected,
    active,
    view,
    onView,
    onEdit,
}: {
    profile: DatabaseProfile;
    connected: Connected;
    active: boolean;
    view: DatabaseView;
    onView: (change: Partial<DatabaseView>) => void;
    onEdit: () => void;
}) {
    const ran = useQuery(profile.id).ran;
    const putInEditor = (sql: string, run: boolean) => {
        loadQuery(profile.id, sql);
        onView({ showing: "query" });
        if (run) void runQuery(profile.id, profile.id, sql);
    };
    const openTable = (table: OpenTable) => onView({ showing: "table", table });
    const tabs: { id: DatabaseView["showing"]; label: string; hidden?: boolean }[] = [
        { id: "query", label: "Query" },
        { id: "table", label: view.table ? view.table.name : "Table", hidden: !view.table },
        { id: "history", label: "History" },
    ];

    return (
        <div className="db-connected">
            <header className="db-connected-head">
                <div className="db-connected-title">
                    <span className="db-row-name">{profile.name}</span>
                    <span className="db-meta">{connected.version}</span>
                </div>
                <div className="db-segmented" role="tablist" aria-label={`${profile.name} views`}>
                    {tabs
                        .filter((tab) => !tab.hidden)
                        .map((tab) => (
                            <button
                                key={tab.id}
                                type="button"
                                role="tab"
                                aria-selected={view.showing === tab.id}
                                className={view.showing === tab.id ? "active" : undefined}
                                onClick={() => onView({ showing: tab.id })}>
                                {tab.label}
                            </button>
                        ))}
                </div>
                <span className="db-grow" />
                <button type="button" className="db-button" onClick={onEdit}>
                    Edit
                </button>
                <button
                    type="button"
                    className="db-button"
                    onClick={() => void databaseApi.disconnect(profile.id).then(refreshDatabase).catch(swallow("disconnect"))}>
                    Disconnect
                </button>
            </header>
            <div className="db-connected-body">
                {view.showing === "table" && view.table ? (
                    <TableView profile={profile} table={view.table} active={active} onQuery={putInEditor} onOpenTable={openTable} />
                ) : view.showing === "history" ? (
                    <HistoryPanel profile={profile} active={active} onOpen={putInEditor} />
                ) : (
                    <QueryWorkspace
                        consoleId={profile.id}
                        profile={profile}
                        resultActions={(result) => <SendResults profile={profile} sql={ran ?? ""} result={result} />}
                    />
                )}
            </div>
        </div>
    );
}
