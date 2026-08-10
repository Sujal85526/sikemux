use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{ffi::ErrorCode, params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};
use crate::observability::{global_observability, SpanOutcome};

const MAX_STATE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ITEM_COUNT: usize = 4_096;
const MAX_ITEM_STATE_BYTES: usize = 1024 * 1024;
const MAX_ITEM_ID_BYTES: usize = 256;
const MAX_ITEM_KIND_BYTES: usize = 128;
const CURRENT_SLOT: i64 = 0;
const BACKUP_SLOT: i64 = 1;
const RECOVERY_SNAPSHOT_ID: i64 = 1;
const DATABASE_SCHEMA_VERSION: i64 = 2;

#[derive(Debug)]
struct ItemStateRow {
    ordinal: i64,
    item_id: String,
    kind: String,
    version: i64,
    state_json: String,
}

#[derive(Debug)]
struct DecomposedSnapshot {
    schema_version: i64,
    core_json: String,
    items: Vec<ItemStateRow>,
}

#[derive(Debug)]
enum SlotLoad {
    Snapshot(String),
    Empty,
    Invalid,
}

#[derive(Debug)]
enum DatabaseLoad {
    Snapshot(String),
    Empty,
    Invalid,
}

/// Legacy JSON location retained as a one-way migration and recovery source.
/// Debug and release remain isolated so development cannot overwrite installed
/// application state.
pub fn state_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let filename = if cfg!(debug_assertions) {
        "state.dev.json"
    } else {
        "state.json"
    };
    Some(PathBuf::from(home).join(".config/sikemux").join(filename))
}

fn database_path() -> Option<PathBuf> {
    let legacy = state_path()?;
    let filename = if cfg!(debug_assertions) {
        "state.dev.sqlite3"
    } else {
        "state.sqlite3"
    };
    Some(legacy.with_file_name(filename))
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn migration_marker_path(database: &Path) -> PathBuf {
    sidecar_path(database, ".legacy-migrated")
}

fn write_migration_marker(database: &Path) -> AppResult<()> {
    let marker = migration_marker_path(database);
    fs::write(&marker, b"1\n")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(marker, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn quarantine_database(path: &Path) -> AppResult<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let quarantine = sidecar_path(path, &format!(".corrupt-{stamp}"));
    fs::rename(path, &quarantine)?;
    for suffix in ["-wal", "-shm"] {
        let source = sidecar_path(path, suffix);
        if source.exists() {
            let target = sidecar_path(&quarantine, suffix);
            fs::rename(source, target)?;
        }
    }
    Ok(quarantine)
}

/// Load the transactional SQLite snapshot, repairing it from the previous-good
/// recovery snapshot when necessary. Legacy JSON is considered only when no
/// authoritative database snapshot exists and migration has not been marked.
#[tauri::command]
pub fn state_load() -> String {
    let Some(database) = database_path() else {
        return String::new();
    };
    let Some(legacy) = state_path() else {
        return String::new();
    };
    state_load_from_paths(&database, &legacy)
}

fn state_load_from_paths(database: &Path, legacy: &Path) -> String {
    if database.exists() {
        match database_user_version(database) {
            Ok(version) if version > DATABASE_SCHEMA_VERSION => return String::new(),
            Ok(_) => match load_database(database) {
                Ok(DatabaseLoad::Snapshot(snapshot)) => {
                    // A successful database load makes every surviving legacy
                    // file stale. Marker failures are retried by state_save and
                    // before any future quarantine.
                    let _ = mark_legacy_if_present(database, legacy);
                    return snapshot;
                }
                Ok(DatabaseLoad::Empty) => {}
                Ok(DatabaseLoad::Invalid) => {
                    if quarantine_authoritative_database(database, legacy).is_err() {
                        return String::new();
                    }
                    return String::new();
                }
                Err(_) => {
                    if !database_has_physical_corruption(database)
                        || quarantine_authoritative_database(database, legacy).is_err()
                    {
                        return String::new();
                    }
                    return String::new();
                }
            },
            Err(error) => {
                if !sqlite_error_is_corruption(&error)
                    && !database_has_physical_corruption(database)
                {
                    return String::new();
                }
                if quarantine_authoritative_database(database, legacy).is_err() {
                    return String::new();
                }
                return String::new();
            }
        }
    }
    migrate_legacy_snapshot(database, legacy)
}

fn legacy_snapshot_exists(legacy: &Path) -> bool {
    legacy.exists() || backup_path(legacy).exists()
}

fn mark_legacy_if_present(database: &Path, legacy: &Path) -> AppResult<()> {
    if legacy_snapshot_exists(legacy) && !migration_marker_path(database).is_file() {
        write_migration_marker(database)?;
    }
    Ok(())
}

fn quarantine_authoritative_database(database: &Path, legacy: &Path) -> AppResult<PathBuf> {
    // Establish the tombstone before moving an authoritative database. If the
    // marker cannot be persisted, leave the database in place so stale JSON
    // can never silently become authoritative on the next launch.
    mark_legacy_if_present(database, legacy)?;
    quarantine_database(database)
}

fn migrate_legacy_snapshot(database: &Path, legacy: &Path) -> String {
    // Once migration succeeded, stale JSON is retained only for manual
    // recovery and must never silently replace a newer corrupt database.
    if migration_marker_path(database).is_file() {
        return String::new();
    }
    let recovered = read_valid_json(legacy)
        .or_else(|| read_valid_json(&backup_path(legacy)))
        .unwrap_or_default();
    if !recovered.is_empty() {
        let observer = global_observability();
        match save_database(database, &recovered) {
            Ok(()) => {
                if write_migration_marker(database).is_err() {
                    let _ = observer.increment_counter("state.legacy_marker_failures", 1);
                }
            }
            Err(_) => {
                // The recovered payload is still the safest boot state. The
                // regular persistence retry can establish SQLite and its
                // migration marker without replacing the UI with defaults.
                let _ = observer.increment_counter("state.legacy_migration_failures", 1);
            }
        }
    }
    recovered
}

#[tauri::command]
pub async fn state_save(data: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || state_save_sync(data))
        .await
        .map_err(|error| AppError::Other(format!("state_save join: {error}")))?
}

fn state_save_sync(data: String) -> AppResult<()> {
    let path = database_path().ok_or_else(|| AppError::State("no home directory".into()))?;
    if let Some(legacy) = state_path() {
        return save_database_and_mark_legacy(&path, &legacy, &data);
    }
    save_database(&path, &data)
}

fn save_database_and_mark_legacy(path: &Path, legacy: &Path, data: &str) -> AppResult<()> {
    save_database(path, data)?;
    mark_legacy_if_present(path, legacy)
}

fn state_error(error: impl std::fmt::Display) -> AppError {
    AppError::State(error.to_string())
}

fn prepare_parent(path: &Path) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::State("invalid state database path".into()))?;
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn secure_database_files(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for candidate in [
            path.to_path_buf(),
            sidecar_path(path, "-wal"),
            sidecar_path(path, "-shm"),
        ] {
            if candidate.exists() {
                fs::set_permissions(candidate, fs::Permissions::from_mode(0o600))?;
            }
        }
    }
    Ok(())
}

fn open_database(path: &Path) -> AppResult<Connection> {
    prepare_parent(path)?;
    let mut connection = Connection::open(path).map_err(state_error)?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(state_error)?;
    let user_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(state_error)?;
    if user_version > DATABASE_SCHEMA_VERSION {
        return Err(AppError::State(format!(
            "state database schema {user_version} is newer than supported schema {DATABASE_SCHEMA_VERSION}"
        )));
    }
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA wal_autocheckpoint = 256;
             CREATE TABLE IF NOT EXISTS workspace_snapshots (
                 slot INTEGER PRIMARY KEY CHECK (slot IN (0, 1)),
                 schema_version INTEGER NOT NULL CHECK (schema_version > 0),
                 core_json TEXT NOT NULL,
                 saved_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS item_states (
                 slot INTEGER NOT NULL CHECK (slot IN (0, 1)),
                 ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
                 item_id TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 item_version INTEGER NOT NULL CHECK (item_version > 0),
                 state_json TEXT NOT NULL,
                 PRIMARY KEY (slot, item_id)
             );
             CREATE INDEX IF NOT EXISTS item_states_order
                 ON item_states(slot, ordinal);
             CREATE TABLE IF NOT EXISTS recovery_snapshots (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 snapshot_json TEXT NOT NULL,
                 saved_at_ms INTEGER NOT NULL
             );",
        )
        .map_err(state_error)?;
    if user_version < DATABASE_SCHEMA_VERSION {
        migrate_database_schema(&mut connection, user_version)?;
    }
    secure_database_files(path)?;
    Ok(connection)
}

fn migrate_database_schema(connection: &mut Connection, from_version: i64) -> AppResult<()> {
    if !(0..DATABASE_SCHEMA_VERSION).contains(&from_version) {
        return Err(AppError::State(format!(
            "cannot migrate state database schema {from_version}"
        )));
    }

    // Schema v1 stored a complete previous snapshot in a second set of item
    // rows. Convert it once to a single sequential recovery blob so future
    // saves only mutate changed live item rows.
    let previous_good = match load_slot(connection, BACKUP_SLOT)? {
        SlotLoad::Snapshot(snapshot) => Some(snapshot),
        SlotLoad::Empty | SlotLoad::Invalid => None,
    };
    let transaction = connection.transaction().map_err(state_error)?;
    if let Some(snapshot) = previous_good {
        write_recovery_snapshot(&transaction, &snapshot)?;
    }
    transaction
        .execute(
            "DELETE FROM item_states WHERE slot = ?1",
            params![BACKUP_SLOT],
        )
        .map_err(state_error)?;
    transaction
        .execute(
            "DELETE FROM workspace_snapshots WHERE slot = ?1",
            params![BACKUP_SLOT],
        )
        .map_err(state_error)?;
    transaction
        .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
        .map_err(state_error)?;
    transaction.commit().map_err(state_error)
}

fn database_user_version(path: &Path) -> rusqlite::Result<i64> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.query_row("PRAGMA user_version", [], |row| row.get(0))
}

fn sqlite_error_is_corruption(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(failure.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

fn database_has_physical_corruption(path: &Path) -> bool {
    let connection = match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(connection) => connection,
        Err(error) => return sqlite_error_is_corruption(&error),
    };
    let result = connection.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0));
    match result {
        Ok(result) => result != "ok",
        Err(error) => sqlite_error_is_corruption(&error),
    }
}

fn bounded_plain_string(value: &Value, max_bytes: usize) -> Option<&str> {
    let value = value.as_str()?;
    if value.is_empty()
        || value.len() > max_bytes
        || value.trim() != value
        || value.chars().any(char::is_control)
        || matches!(value, "__proto__" | "constructor" | "prototype")
    {
        return None;
    }
    Some(value)
}

fn decompose_snapshot(data: &str) -> AppResult<DecomposedSnapshot> {
    if data.len() > MAX_STATE_BYTES {
        return Err(AppError::State(
            "state snapshot exceeds 32 MiB limit".into(),
        ));
    }
    let mut root = serde_json::from_str::<Value>(data)?;
    let object = root
        .as_object_mut()
        .ok_or_else(|| AppError::State("state snapshot root must be an object".into()))?;
    let schema_version = object
        .get("version")
        .and_then(Value::as_i64)
        .filter(|version| *version > 0)
        .ok_or_else(|| AppError::State("state snapshot version is invalid".into()))?;
    let raw_items = object
        .remove("itemStates")
        .unwrap_or_else(|| Value::Object(Map::new()));
    let raw_items = raw_items
        .as_object()
        .ok_or_else(|| AppError::State("itemStates must be an object".into()))?;
    if raw_items.len() > MAX_ITEM_COUNT {
        return Err(AppError::State(
            "state snapshot exceeds 4096 item limit".into(),
        ));
    }

    let mut items = Vec::with_capacity(raw_items.len());
    for (ordinal, (map_key, envelope)) in raw_items.iter().enumerate() {
        let envelope = envelope
            .as_object()
            .filter(|value| value.len() == 4)
            .ok_or_else(|| AppError::State("item state envelope is malformed".into()))?;
        if !["itemId", "kind", "version", "state"]
            .iter()
            .all(|key| envelope.contains_key(*key))
        {
            return Err(AppError::State("item state envelope is malformed".into()));
        }
        let item_id = bounded_plain_string(
            envelope
                .get("itemId")
                .ok_or_else(|| AppError::State("item state id is missing".into()))?,
            MAX_ITEM_ID_BYTES,
        )
        .filter(|item_id| *item_id == map_key)
        .ok_or_else(|| AppError::State("item state id is invalid or mismatched".into()))?;
        let kind = bounded_plain_string(
            envelope
                .get("kind")
                .ok_or_else(|| AppError::State("item state kind is missing".into()))?,
            MAX_ITEM_KIND_BYTES,
        )
        .ok_or_else(|| AppError::State("item state kind is invalid".into()))?;
        let version = envelope
            .get("version")
            .and_then(Value::as_i64)
            .filter(|version| *version > 0)
            .ok_or_else(|| AppError::State("item state version is invalid".into()))?;
        let state_json = serde_json::to_string(
            envelope
                .get("state")
                .ok_or_else(|| AppError::State("item state payload is missing".into()))?,
        )?;
        if state_json.len() > MAX_ITEM_STATE_BYTES {
            return Err(AppError::State(
                "individual item state exceeds 1 MiB limit".into(),
            ));
        }
        items.push(ItemStateRow {
            ordinal: ordinal as i64,
            item_id: item_id.to_owned(),
            kind: kind.to_owned(),
            version,
            state_json,
        });
    }

    let core_json = serde_json::to_string(&root)?;
    Ok(DecomposedSnapshot {
        schema_version,
        core_json,
        items,
    })
}

fn save_database(path: &Path, data: &str) -> AppResult<()> {
    let snapshot = decompose_snapshot(data)?;
    let observer = global_observability();
    let timer = observer.slow_operation(
        "state.sqlite_save",
        Duration::from_millis(16),
        None,
        Default::default(),
    );
    let mut connection = open_database(path)?;
    let transaction = connection.transaction().map_err(state_error)?;
    let (changed_items, removed_items) = write_transaction(&transaction, &snapshot)?;
    transaction.commit().map_err(state_error)?;
    secure_database_files(path)?;
    let _ = observer.increment_counter("state.sqlite_saves", 1);
    let _ = observer.increment_counter("state.sqlite.changed_items", changed_items as u64);
    let _ = observer.increment_counter("state.sqlite.removed_items", removed_items as u64);
    observer.set_gauge("state.sqlite.last_item_count", snapshot.items.len() as f64);
    observer.set_gauge("state.sqlite.last_snapshot_bytes", data.len() as f64);
    timer.finish(SpanOutcome::Success);
    Ok(())
}

fn write_transaction(
    transaction: &Transaction<'_>,
    snapshot: &DecomposedSnapshot,
) -> AppResult<(usize, usize)> {
    if let SlotLoad::Snapshot(previous_good) = load_slot(transaction, CURRENT_SLOT)? {
        write_recovery_snapshot(transaction, &previous_good)?;
    }
    write_current_snapshot(transaction, snapshot)
}

fn unix_time_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn write_recovery_snapshot(transaction: &Transaction<'_>, snapshot: &str) -> AppResult<()> {
    // Recovery is already a validated, bounded assembled snapshot from
    // load_slot. Keeping it in one row avoids copying every item row on each
    // save while retaining transactionally consistent previous-good state.
    if snapshot.len() > MAX_STATE_BYTES || decompose_snapshot(snapshot).is_err() {
        return Err(AppError::State("recovery snapshot is invalid".into()));
    }
    transaction
        .execute(
            "INSERT INTO recovery_snapshots(id, snapshot_json, saved_at_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                 snapshot_json = excluded.snapshot_json,
                 saved_at_ms = excluded.saved_at_ms",
            params![RECOVERY_SNAPSHOT_ID, snapshot, unix_time_millis()],
        )
        .map_err(state_error)?;
    Ok(())
}

fn write_current_snapshot(
    transaction: &Transaction<'_>,
    snapshot: &DecomposedSnapshot,
) -> AppResult<(usize, usize)> {
    transaction
        .execute(
            "INSERT INTO workspace_snapshots(slot, schema_version, core_json, saved_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(slot) DO UPDATE SET
                 schema_version = excluded.schema_version,
                 core_json = excluded.core_json,
                 saved_at_ms = excluded.saved_at_ms",
            params![
                CURRENT_SLOT,
                snapshot.schema_version,
                snapshot.core_json,
                unix_time_millis()
            ],
        )
        .map_err(state_error)?;
    let mut existing_statement = transaction
        .prepare("SELECT item_id FROM item_states WHERE slot = ?1")
        .map_err(state_error)?;
    let mut stale_item_ids = existing_statement
        .query_map(params![CURRENT_SLOT], |row| row.get::<_, String>(0))
        .map_err(state_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(state_error)?;
    drop(existing_statement);

    let mut statement = transaction
        .prepare_cached(
            "INSERT INTO item_states(slot, ordinal, item_id, kind, item_version, state_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(slot, item_id) DO UPDATE SET
                 ordinal = excluded.ordinal,
                 kind = excluded.kind,
                 item_version = excluded.item_version,
                 state_json = excluded.state_json
             WHERE ordinal IS NOT excluded.ordinal
                OR kind IS NOT excluded.kind
                OR item_version IS NOT excluded.item_version
                OR state_json IS NOT excluded.state_json",
        )
        .map_err(state_error)?;
    let mut changed_items = 0usize;
    for item in &snapshot.items {
        changed_items += statement
            .execute(params![
                CURRENT_SLOT,
                item.ordinal,
                item.item_id,
                item.kind,
                item.version,
                item.state_json
            ])
            .map_err(state_error)?;
        stale_item_ids.remove(&item.item_id);
    }
    drop(statement);
    let removed_items = stale_item_ids.len();
    let mut delete_statement = transaction
        .prepare_cached("DELETE FROM item_states WHERE slot = ?1 AND item_id = ?2")
        .map_err(state_error)?;
    for item_id in stale_item_ids {
        delete_statement
            .execute(params![CURRENT_SLOT, item_id])
            .map_err(state_error)?;
    }
    Ok((changed_items, removed_items))
}

fn load_database(path: &Path) -> AppResult<DatabaseLoad> {
    let mut connection = open_database(path)?;
    let current = load_slot(&connection, CURRENT_SLOT)?;
    if let SlotLoad::Snapshot(snapshot) = &current {
        return Ok(DatabaseLoad::Snapshot(snapshot.clone()));
    }

    let recovery = load_recovery_snapshot(&connection)?;
    if let SlotLoad::Snapshot(snapshot) = &recovery {
        let decomposed = decompose_snapshot(snapshot)?;
        let transaction = connection.transaction().map_err(state_error)?;
        write_current_snapshot(&transaction, &decomposed)?;
        transaction.commit().map_err(state_error)?;
        return Ok(DatabaseLoad::Snapshot(snapshot.clone()));
    }

    Ok(match (current, recovery) {
        (SlotLoad::Empty, SlotLoad::Empty) => DatabaseLoad::Empty,
        _ => DatabaseLoad::Invalid,
    })
}

fn load_recovery_snapshot(connection: &Connection) -> AppResult<SlotLoad> {
    let snapshot = connection
        .query_row(
            "SELECT snapshot_json FROM recovery_snapshots WHERE id = ?1",
            params![RECOVERY_SNAPSHOT_ID],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(state_error)?;
    let Some(snapshot) = snapshot else {
        return Ok(SlotLoad::Empty);
    };
    if snapshot.len() > MAX_STATE_BYTES || decompose_snapshot(&snapshot).is_err() {
        return Ok(SlotLoad::Invalid);
    }
    Ok(SlotLoad::Snapshot(snapshot))
}

fn load_slot(connection: &Connection, slot: i64) -> AppResult<SlotLoad> {
    let snapshot = connection
        .query_row(
            "SELECT schema_version, core_json FROM workspace_snapshots WHERE slot = ?1",
            params![slot],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(state_error)?;
    let Some((schema_version, core_json)) = snapshot else {
        return Ok(SlotLoad::Empty);
    };
    if core_json.len() > MAX_STATE_BYTES {
        return Ok(SlotLoad::Invalid);
    }
    let mut root = match serde_json::from_str::<Value>(&core_json) {
        Ok(Value::Object(root)) => root,
        _ => return Ok(SlotLoad::Invalid),
    };
    if root.get("version").and_then(Value::as_i64) != Some(schema_version)
        || root.contains_key("itemStates")
    {
        return Ok(SlotLoad::Invalid);
    }
    let mut statement = connection
        .prepare(
            "SELECT ordinal, item_id, kind, item_version, state_json
             FROM item_states WHERE slot = ?1 ORDER BY ordinal ASC",
        )
        .map_err(state_error)?;
    let rows = statement
        .query_map(params![slot], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(state_error)?;
    let mut item_states = Map::new();
    for row in rows {
        let (ordinal, item_id, kind, version, state_json) = row.map_err(state_error)?;
        if item_states.len() >= MAX_ITEM_COUNT
            || ordinal != item_states.len() as i64
            || bounded_plain_string(&Value::String(item_id.clone()), MAX_ITEM_ID_BYTES).is_none()
            || bounded_plain_string(&Value::String(kind.clone()), MAX_ITEM_KIND_BYTES).is_none()
            || version <= 0
            || state_json.len() > MAX_ITEM_STATE_BYTES
        {
            return Ok(SlotLoad::Invalid);
        }
        let state = match serde_json::from_str::<Value>(&state_json) {
            Ok(state) => state,
            Err(_) => return Ok(SlotLoad::Invalid),
        };
        item_states.insert(
            item_id.clone(),
            Value::Object(Map::from_iter([
                ("itemId".to_owned(), Value::String(item_id)),
                ("kind".to_owned(), Value::String(kind)),
                ("version".to_owned(), Value::Number(version.into())),
                ("state".to_owned(), state),
            ])),
        );
    }
    root.insert("itemStates".to_owned(), Value::Object(item_states));
    let snapshot = serde_json::to_string(&Value::Object(root))?;
    if snapshot.len() > MAX_STATE_BYTES || decompose_snapshot(&snapshot).is_err() {
        return Ok(SlotLoad::Invalid);
    }
    Ok(SlotLoad::Snapshot(snapshot))
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".bak");
    PathBuf::from(name)
}

fn read_valid_json(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_STATE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_STATE_BYTES {
        return None;
    }
    let data = String::from_utf8(bytes).ok()?;
    serde_json::from_str::<Value>(&data).ok()?;
    Some(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(theme: &str, items: &str) -> String {
        format!(r#"{{"version":7,"theme":"{theme}","itemStates":{items}}}"#)
    }

    fn expect_snapshot(load: DatabaseLoad) -> String {
        match load {
            DatabaseLoad::Snapshot(snapshot) => snapshot,
            other => panic!("expected snapshot, got {other:?}"),
        }
    }

    fn expect_slot_snapshot(load: SlotLoad) -> String {
        match load {
            SlotLoad::Snapshot(snapshot) => snapshot,
            other => panic!("expected slot snapshot, got {other:?}"),
        }
    }

    fn theme(snapshot: &str) -> String {
        serde_json::from_str::<Value>(snapshot).unwrap()["theme"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn sqlite_round_trip_separates_and_reassembles_item_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let data = snapshot(
            "dark",
            r#"{"editor-1":{"itemId":"editor-1","kind":"editor","version":1,"state":{"openTabs":["/a"]}}}"#,
        );

        save_database(&path, &data).unwrap();
        let loaded = expect_snapshot(load_database(&path).unwrap());
        assert_eq!(loaded, data);

        let connection = Connection::open(&path).unwrap();
        let core: String = connection
            .query_row(
                "SELECT core_json FROM workspace_snapshots WHERE slot = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!core.contains("editor-1"));
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM item_states WHERE slot = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn each_commit_keeps_one_transactional_previous_good_snapshot_without_backup_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let first = snapshot("first", "{}");
        let second = snapshot("second", "{}");
        save_database(&path, &first).unwrap();
        save_database(&path, &second).unwrap();

        let connection = open_database(&path).unwrap();
        let current = expect_slot_snapshot(load_slot(&connection, CURRENT_SLOT).unwrap());
        let recovery = expect_slot_snapshot(load_recovery_snapshot(&connection).unwrap());
        assert_eq!(theme(&current), "second");
        assert_eq!(theme(&recovery), "first");
        let backup_item_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM item_states WHERE slot = ?1",
                params![BACKUP_SLOT],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(backup_item_rows, 0);
    }

    #[test]
    fn unchanged_items_are_not_rewritten_and_removed_items_delete_individually() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let with_item = snapshot(
            "first",
            r#"{"editor":{"itemId":"editor","kind":"editor","version":1,"state":{"value":1}}}"#,
        );
        save_database(&path, &with_item).unwrap();

        let mut connection = open_database(&path).unwrap();
        let unchanged = decompose_snapshot(&snapshot(
            "second",
            r#"{"editor":{"itemId":"editor","kind":"editor","version":1,"state":{"value":1}}}"#,
        ))
        .unwrap();
        let transaction = connection.transaction().unwrap();
        assert_eq!(write_transaction(&transaction, &unchanged).unwrap(), (0, 0));
        transaction.commit().unwrap();

        let without_item = decompose_snapshot(&snapshot("third", "{}")).unwrap();
        let transaction = connection.transaction().unwrap();
        assert_eq!(
            write_transaction(&transaction, &without_item).unwrap(),
            (0, 1)
        );
        transaction.commit().unwrap();
        assert_eq!(
            theme(&expect_snapshot(load_database(&path).unwrap())),
            "third"
        );
    }

    #[test]
    fn malformed_or_oversized_item_envelopes_are_rejected_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let valid = snapshot("safe", "{}");
        save_database(&path, &valid).unwrap();

        let mismatched = snapshot(
            "unsafe",
            r#"{"key":{"itemId":"other","kind":"editor","version":1,"state":null}}"#,
        );
        assert!(save_database(&path, &mismatched).is_err());
        let loaded = expect_snapshot(load_database(&path).unwrap());
        assert_eq!(theme(&loaded), "safe");

        let oversized_state = "x".repeat(MAX_ITEM_STATE_BYTES + 1);
        let oversized = snapshot(
            "unsafe",
            &format!(
                r#"{{"key":{{"itemId":"key","kind":"editor","version":1,"state":"{oversized_state}"}}}}"#
            ),
        );
        assert!(save_database(&path, &oversized).is_err());
    }

    #[test]
    fn corrupt_current_is_repaired_from_recovery_before_the_next_save() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        save_database(&path, &snapshot("backup", "{}")).unwrap();
        save_database(&path, &snapshot("current", "{}")).unwrap();

        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE workspace_snapshots SET core_json = '{' WHERE slot = 0",
                [],
            )
            .unwrap();
        drop(connection);
        let loaded = expect_snapshot(load_database(&path).unwrap());
        assert_eq!(theme(&loaded), "backup");

        let connection = open_database(&path).unwrap();
        let repaired = expect_slot_snapshot(load_slot(&connection, CURRENT_SLOT).unwrap());
        assert_eq!(theme(&repaired), "backup");
        drop(connection);

        save_database(&path, &snapshot("next", "{}")).unwrap();
        let connection = open_database(&path).unwrap();
        let recovery = expect_slot_snapshot(load_recovery_snapshot(&connection).unwrap());
        assert_eq!(theme(&recovery), "backup");
    }

    #[test]
    fn legacy_migration_is_marked_and_stale_json_cannot_resurrect() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        let legacy = directory.path().join("state.json");
        let legacy_snapshot = snapshot("legacy", "{}");
        fs::write(&legacy, &legacy_snapshot).unwrap();

        assert_eq!(migrate_legacy_snapshot(&database, &legacy), legacy_snapshot);
        assert!(database.exists());
        assert!(migration_marker_path(&database).exists());
        assert_eq!(
            database_user_version(&database).unwrap(),
            DATABASE_SCHEMA_VERSION
        );

        fs::write(&legacy, snapshot("stale", "{}")).unwrap();
        fs::write(&database, b"not a database").unwrap();
        assert!(state_load_from_paths(&database, &legacy).is_empty());
        assert!(!database.exists());
        assert!(migration_marker_path(&database).is_file());
        assert!(state_load_from_paths(&database, &legacy).is_empty());
    }

    #[test]
    fn future_database_schema_is_preserved_and_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION + 1)
            .unwrap();
        drop(connection);

        assert_eq!(
            database_user_version(&path).unwrap(),
            DATABASE_SCHEMA_VERSION + 1
        );
        assert!(open_database(&path).is_err());
        assert!(path.exists());
    }

    #[test]
    fn schema_one_backup_rows_migrate_to_the_recovery_blob() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let mut connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workspace_snapshots (
                     slot INTEGER PRIMARY KEY CHECK (slot IN (0, 1)),
                     schema_version INTEGER NOT NULL,
                     core_json TEXT NOT NULL,
                     saved_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE item_states (
                     slot INTEGER NOT NULL CHECK (slot IN (0, 1)),
                     ordinal INTEGER NOT NULL,
                     item_id TEXT NOT NULL,
                     kind TEXT NOT NULL,
                     item_version INTEGER NOT NULL,
                     state_json TEXT NOT NULL,
                     PRIMARY KEY (slot, item_id)
                 );
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        let current = decompose_snapshot(&snapshot("current", "{}")).unwrap();
        let backup = decompose_snapshot(&snapshot(
            "backup",
            r#"{"editor":{"itemId":"editor","kind":"editor","version":1,"state":{"value":1}}}"#,
        ))
        .unwrap();
        let transaction = connection.transaction().unwrap();
        write_current_snapshot(&transaction, &current).unwrap();
        transaction
            .execute(
                "INSERT INTO workspace_snapshots(slot, schema_version, core_json, saved_at_ms)
                 VALUES (?1, ?2, ?3, 1)",
                params![BACKUP_SLOT, backup.schema_version, backup.core_json],
            )
            .unwrap();
        for item in &backup.items {
            transaction
                .execute(
                    "INSERT INTO item_states(slot, ordinal, item_id, kind, item_version, state_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        BACKUP_SLOT,
                        item.ordinal,
                        item.item_id,
                        item.kind,
                        item.version,
                        item.state_json
                    ],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
        drop(connection);

        let connection = open_database(&path).unwrap();
        assert_eq!(
            database_user_version(&path).unwrap(),
            DATABASE_SCHEMA_VERSION
        );
        let recovery = expect_slot_snapshot(load_recovery_snapshot(&connection).unwrap());
        assert_eq!(theme(&recovery), "backup");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM item_states WHERE slot = ?1",
                    params![BACKUP_SLOT],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn busy_database_is_preserved_instead_of_quarantined() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        let legacy = directory.path().join("state.json");
        save_database(&database, &snapshot("current", "{}")).unwrap();
        let lock = Connection::open(&database).unwrap();
        lock.execute_batch("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;")
            .unwrap();

        assert!(state_load_from_paths(&database, &legacy).is_empty());
        assert!(database.exists());
        let quarantines = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(quarantines, 0);
        lock.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn marker_failures_are_reported_and_retried_after_database_commit() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        let legacy = directory.path().join("state.json");
        fs::write(&legacy, snapshot("legacy", "{}")).unwrap();
        let marker = migration_marker_path(&database);
        fs::create_dir(&marker).unwrap();

        assert!(
            save_database_and_mark_legacy(&database, &legacy, &snapshot("current", "{}")).is_err()
        );
        assert_eq!(
            theme(&expect_snapshot(load_database(&database).unwrap())),
            "current"
        );

        fs::remove_dir(&marker).unwrap();
        save_database_and_mark_legacy(&database, &legacy, &snapshot("current", "{}")).unwrap();
        assert!(marker.is_file());
    }

    #[test]
    fn migration_returns_recovered_state_when_the_marker_is_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("state.sqlite3");
        let legacy = directory.path().join("state.json");
        let recovered = snapshot("recovered", "{}");
        fs::write(&legacy, &recovered).unwrap();
        fs::create_dir(migration_marker_path(&database)).unwrap();

        assert_eq!(migrate_legacy_snapshot(&database, &legacy), recovered);
        assert_eq!(
            theme(&expect_snapshot(load_database(&database).unwrap())),
            "recovered"
        );
    }

    #[test]
    fn invalid_legacy_primary_can_fall_back_to_json_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        fs::write(&path, "{").unwrap();
        fs::write(backup_path(&path), r#"{"version":7,"itemStates":{}}"#).unwrap();
        assert!(read_valid_json(&path).is_none());
        assert!(read_valid_json(&backup_path(&path)).is_some());
    }
}
