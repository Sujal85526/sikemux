import { useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, IconPlus, SkeletonRows } from "../../../plugin-api/ui";
import { refreshDatabase, type Connected, type DatabaseProfile } from "../api";
import { addressOf, blankDraft, draftOf, engineLabel } from "../profileForm";
import { databaseConnectedR, databaseProfilesR } from "../resources";
import { updateDatabaseView, useDatabaseView } from "../state";
import { forgetQuery } from "../queryState";
import { ConnectedDatabase } from "./ConnectedDatabase";
import { DatabaseMark } from "./DatabaseMark";
import { ProfileDetail } from "./ProfileDetail";
import { ProfileForm } from "./ProfileForm";
import { SchemaTree } from "./SchemaTree";
import "../database.css";

export function DatabasePane({ paneId, active }: { paneId: string; active: boolean }) {
    const profiles = useResourceEnabled(active, databaseProfilesR);
    const connected = useResourceEnabled(active, databaseConnectedR);
    const view = useDatabaseView(paneId);

    if (profiles.status === "error") return <EmptyState message={profiles.error ?? "Sikemux could not read the saved connections."} tone="error" />;
    if (!profiles.data) return <SkeletonRows rows={4} label="Loading connections" />;

    const list = profiles.data;
    const selected = list.find((profile) => profile.id === view.selected) ?? null;
    const connectionOf = (id: string) => connected.data?.find((entry) => entry.id === id) ?? null;
    const selectedConnection = selected ? connectionOf(selected.id) : null;
    const open = (change: Parameters<typeof updateDatabaseView>[1]) => updateDatabaseView(paneId, change);
    const pick = (id: string) =>
        open(id === view.selected ? { editing: null } : { selected: id, editing: null, showing: "query", schema: null, table: null });
    const afterSave = (profile: DatabaseProfile) => {
        refreshDatabase();
        open({ selected: profile.id, editing: null });
    };

    if (list.length === 0 && view.editing !== "new") {
        return (
            <div className="db-pane db-pane-empty">
                <div className="db-welcome">
                    <DatabaseMark size={30} />
                    <h2>Connect a database</h2>
                    <p>
                        Save a PostgreSQL or MySQL server, or a SQLite file, to browse its tables and run SQL beside your code. Your agents can use it
                        too.
                    </p>
                    <button type="button" className="db-button primary" onClick={() => open({ editing: "new" })}>
                        Add a connection
                    </button>
                    <p className="db-hint">Passwords stay in the macOS Keychain.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="db-pane">
            <nav className="db-sidebar" aria-label="Saved connections">
                <div className="db-sidebar-head">
                    <span className="db-heading">Connections</span>
                    <button
                        type="button"
                        className="db-icon-button"
                        title="New connection"
                        aria-label="New connection"
                        onClick={() => open({ editing: "new" })}>
                        <IconPlus size={13} />
                    </button>
                </div>
                <div className="db-list" role="list">
                    {list.map((profile) => (
                        <ProfileRow
                            key={profile.id}
                            profile={profile}
                            connected={connectionOf(profile.id)}
                            selected={profile.id === view.selected && view.editing !== "new"}
                            onSelect={() => pick(profile.id)}
                        />
                    ))}
                </div>
                {selected && selectedConnection && view.editing === null && (
                    <SchemaTree
                        profile={selected}
                        active={active}
                        schema={view.schema}
                        table={view.showing === "table" ? view.table : null}
                        onSchema={(schema) => open({ schema })}
                        onOpen={(table) => open({ showing: "table", table })}
                    />
                )}
            </nav>
            <section className="db-main">
                {view.editing === "new" ? (
                    <ProfileForm
                        key="new"
                        initial={blankDraft()}
                        saved={null}
                        onSaved={afterSave}
                        onRemoved={() => open({ editing: null })}
                        onCancel={() => open({ editing: null })}
                    />
                ) : selected && view.editing === "selected" ? (
                    <ProfileForm
                        key={selected.id}
                        initial={draftOf(selected)}
                        saved={selected}
                        onSaved={afterSave}
                        onRemoved={() => {
                            forgetQuery(selected.id);
                            refreshDatabase();
                            open({ selected: null, editing: null, table: null });
                        }}
                        onCancel={() => open({ editing: null })}
                    />
                ) : selected && selectedConnection ? (
                    <ConnectedDatabase
                        key={selected.id}
                        profile={selected}
                        connected={selectedConnection}
                        active={active}
                        view={view}
                        onView={open}
                        onEdit={() => open({ editing: "selected" })}
                    />
                ) : selected ? (
                    <ProfileDetail key={selected.id} profile={selected} connected={null} onEdit={() => open({ editing: "selected" })} />
                ) : (
                    <EmptyState message="Pick a connection to see it, or add a new one." />
                )}
            </section>
        </div>
    );
}

function ProfileRow({
    profile,
    connected,
    selected,
    onSelect,
}: {
    profile: DatabaseProfile;
    connected: Connected | null;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <button type="button" role="listitem" className={`db-row${selected ? " active" : ""}`} onClick={onSelect}>
            <span className="db-row-top">
                <span className="db-row-name">{profile.name}</span>
                {connected && <span className="db-dot" title={`Connected to ${connected.version}`} aria-label="Connected" />}
            </span>
            <span className="db-meta">
                {engineLabel(profile.engine)} · {addressOf(profile)}
            </span>
        </button>
    );
}
