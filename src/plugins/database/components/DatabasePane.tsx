import { useState } from "react";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, IconPlus, SkeletonRows } from "../../../plugin-api/ui";
import { databaseApi, failureMessage, refreshDatabase, type Connected, type DatabaseProfile } from "../api";
import { addressOf, blankDraft, draftOf, engineLabel } from "../profileForm";
import { databaseConnectedR, databaseProfilesR } from "../resources";
import { updateDatabaseView, useDatabaseView } from "../state";
import { DatabaseMark } from "./DatabaseMark";
import { ProfileForm } from "./ProfileForm";
import "../database.css";

export function DatabasePane({ paneId, active }: { paneId: string; active: boolean }) {
    const profiles = useResourceEnabled(active, databaseProfilesR);
    const connected = useResourceEnabled(active, databaseConnectedR);
    const view = useDatabaseView(paneId);

    if (profiles.status === "error") return <EmptyState message={profiles.error ?? "Sikemux could not read the saved connections."} tone="error" />;
    if (!profiles.data) return <SkeletonRows rows={4} label="Loading connections" />;

    const list = profiles.data;
    const selected = list.find((profile) => profile.id === view.selected) ?? null;
    const open = (change: Parameters<typeof updateDatabaseView>[1]) => updateDatabaseView(paneId, change);
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
                    <p>Save a PostgreSQL server or a SQLite file to browse its tables and run SQL beside your code.</p>
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
                            connected={connected.data?.find((entry) => entry.id === profile.id) ?? null}
                            selected={profile.id === view.selected && view.editing !== "new"}
                            onSelect={() => open({ selected: profile.id, editing: null })}
                        />
                    ))}
                </div>
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
                            refreshDatabase();
                            open({ selected: null, editing: null });
                        }}
                        onCancel={() => open({ editing: null })}
                    />
                ) : selected ? (
                    <ProfileDetail
                        key={selected.id}
                        profile={selected}
                        connected={connected.data?.find((entry) => entry.id === selected.id) ?? null}
                        onEdit={() => open({ editing: "selected" })}
                    />
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

function ProfileDetail({ profile, connected, onEdit }: { profile: DatabaseProfile; connected: Connected | null; onEdit: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toggle = async () => {
        setBusy(true);
        setError(null);
        try {
            if (connected) await databaseApi.disconnect(profile.id);
            else await databaseApi.connect(profile.id);
            refreshDatabase();
        } catch (failure) {
            setError(failureMessage(failure));
        } finally {
            setBusy(false);
        }
    };

    return (
        <article className="db-detail" aria-label={profile.name}>
            <header className="db-detail-head">
                <h2>{profile.name}</h2>
                {profile.readOnly && <span className="db-badge">Read only</span>}
            </header>
            <dl className="db-facts">
                <dt>Engine</dt>
                <dd>{engineLabel(profile.engine)}</dd>
                {profile.engine === "postgres" ? (
                    <>
                        <dt>Server</dt>
                        <dd className="mono">
                            {profile.host}:{profile.port ?? 5432}
                        </dd>
                        <dt>Database</dt>
                        <dd className="mono">{profile.database || profile.user}</dd>
                        <dt>User</dt>
                        <dd className="mono">{profile.user}</dd>
                        <dt>Password</dt>
                        <dd>{profile.hasPassword ? "Saved in the Keychain" : "None"}</dd>
                    </>
                ) : (
                    <>
                        <dt>File</dt>
                        <dd className="mono">{profile.path}</dd>
                    </>
                )}
                <dt>Status</dt>
                <dd>{connected ? `Connected to ${connected.version}` : "Not connected"}</dd>
            </dl>
            {error && (
                <div className="db-callout" data-tone="danger" role="alert">
                    {error}
                </div>
            )}
            <div className="db-actions">
                <button type="button" className="db-button" onClick={onEdit}>
                    Edit
                </button>
                <button type="button" className={`db-button${connected ? "" : " primary"}`} disabled={busy} onClick={() => void toggle()}>
                    {busy ? (connected ? "Disconnecting…" : "Connecting…") : connected ? "Disconnect" : "Connect"}
                </button>
            </div>
        </article>
    );
}
