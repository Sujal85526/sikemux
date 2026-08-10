use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
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
const DATABASE_SCHEMA_VERSION: i64 = 1;

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

/// Load the transactional SQLite snapshot, falling back to its previous-good
/// slot and then the legacy JSON/backup. A valid legacy snapshot is migrated
/// opportunistically but remains on disk as a recovery source.
#[tauri::command]
pub fn state_load() -> String {
    let Some(database) = database_path() else {
        return String::new();
    };
    if database.exists() {
        match database_user_version(&database) {
            Ok(version) if version > DATABASE_SCHEMA_VERSION => return String::new(),
            Ok(_) => match load_database(&database) {
                Ok(Some(snapshot)) => return snapshot,
                Ok(None) | Err(_) => {
                    if quarantine_database(&database).is_err() {
                        return String::new();
                    }
                }
            },
            Err(_) => {
                if quarantine_database(&database).is_err() {
                    return String::new();
                }
            }
        }
    }

    let Some(legacy) = state_path() else {
        return String::new();
    };
    migrate_legacy_snapshot(&database, &legacy)
}

fn migrate_legacy_snapshot(database: &Path, legacy: &Path) -> String {
    // Once migration succeeded, stale JSON is retained only for manual
    // recovery and must never silently replace a newer corrupt database.
    if migration_marker_path(database).exists() {
        return String::new();
    }
    let recovered = read_valid_json(legacy)
        .or_else(|| read_valid_json(&backup_path(legacy)))
        .unwrap_or_default();
    if !recovered.is_empty() && save_database(database, &recovered).is_ok() {
        let _ = write_migration_marker(database);
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
    save_database(&path, &data)
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
    let connection = Connection::open(path).map_err(state_error)?;
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
                 ON item_states(slot, ordinal);",
        )
        .map_err(state_error)?;
    if user_version == 0 {
        connection
            .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
            .map_err(state_error)?;
    }
    secure_database_files(path)?;
    Ok(connection)
}

fn database_user_version(path: &Path) -> AppResult<i64> {
    let connection = Connection::open(path).map_err(state_error)?;
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(state_error)
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
        .execute(
            "INSERT INTO workspace_snapshots(slot, schema_version, core_json, saved_at_ms)
             SELECT ?1, schema_version, core_json, saved_at_ms
             FROM workspace_snapshots WHERE slot = ?2",
            params![BACKUP_SLOT, CURRENT_SLOT],
        )
        .map_err(state_error)?;
    transaction
        .execute(
            "INSERT INTO item_states(slot, ordinal, item_id, kind, item_version, state_json)
             SELECT ?1, ordinal, item_id, kind, item_version, state_json
             FROM item_states WHERE slot = ?2",
            params![BACKUP_SLOT, CURRENT_SLOT],
        )
        .map_err(state_error)?;
    let saved_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64;
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
                saved_at_ms
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

fn load_database(path: &Path) -> AppResult<Option<String>> {
    let connection = open_database(path)?;
    let current = load_slot(&connection, CURRENT_SLOT)?;
    if current.is_some() {
        return Ok(current);
    }
    load_slot(&connection, BACKUP_SLOT)
}

fn load_slot(connection: &Connection, slot: i64) -> AppResult<Option<String>> {
    let snapshot = connection
        .query_row(
            "SELECT schema_version, core_json FROM workspace_snapshots WHERE slot = ?1",
            params![slot],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(state_error)?;
    let Some((schema_version, core_json)) = snapshot else {
        return Ok(None);
    };
    if core_json.len() > MAX_STATE_BYTES {
        return Ok(None);
    }
    let mut root = match serde_json::from_str::<Value>(&core_json) {
        Ok(Value::Object(root)) => root,
        _ => return Ok(None),
    };
    if root.get("version").and_then(Value::as_i64) != Some(schema_version) {
        return Ok(None);
    }
    let mut statement = connection
        .prepare(
            "SELECT item_id, kind, item_version, state_json
             FROM item_states WHERE slot = ?1 ORDER BY ordinal ASC",
        )
        .map_err(state_error)?;
    let rows = statement
        .query_map(params![slot], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(state_error)?;
    let mut item_states = Map::new();
    for row in rows {
        let (item_id, kind, version, state_json) = row.map_err(state_error)?;
        if item_states.len() >= MAX_ITEM_COUNT
            || item_id.len() > MAX_ITEM_ID_BYTES
            || kind.len() > MAX_ITEM_KIND_BYTES
            || version <= 0
            || state_json.len() > MAX_ITEM_STATE_BYTES
        {
            return Ok(None);
        }
        let state = match serde_json::from_str::<Value>(&state_json) {
            Ok(state) => state,
            Err(_) => return Ok(None),
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
    if snapshot.len() > MAX_STATE_BYTES {
        return Ok(None);
    }
    Ok(Some(snapshot))
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

    #[test]
    fn sqlite_round_trip_separates_and_reassembles_item_rows() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let data = snapshot(
            "dark",
            r#"{"editor-1":{"itemId":"editor-1","kind":"editor","version":1,"state":{"openTabs":["/a"]}}}"#,
        );

        save_database(&path, &data).unwrap();
        let loaded = load_database(&path).unwrap().unwrap();
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
    fn each_commit_keeps_one_transactional_previous_good_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let first = snapshot("first", "{}");
        let second = snapshot("second", "{}");
        save_database(&path, &first).unwrap();
        save_database(&path, &second).unwrap();

        let connection = open_database(&path).unwrap();
        let current = load_slot(&connection, CURRENT_SLOT).unwrap().unwrap();
        let backup = load_slot(&connection, BACKUP_SLOT).unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&current).unwrap()["theme"],
            "second"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&backup).unwrap()["theme"],
            "first"
        );
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
            serde_json::from_str::<Value>(&load_database(&path).unwrap().unwrap()).unwrap()
                ["theme"],
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
        let loaded = load_database(&path).unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&loaded).unwrap()["theme"],
            "safe"
        );

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
    fn corrupt_current_slot_can_fall_back_to_backup_slot() {
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
        let loaded = load_database(&path).unwrap().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&loaded).unwrap()["theme"],
            "backup"
        );
    }

    #[test]
    fn legacy_migration_is_marked_and_corrupt_database_is_quarantined() {
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
        let quarantine = quarantine_database(&database).unwrap();
        assert!(quarantine.exists());
        assert!(!database.exists());
        assert!(migrate_legacy_snapshot(&database, &legacy).is_empty());
    }

    #[test]
    fn future_database_schema_is_preserved_and_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();
        drop(connection);

        assert_eq!(database_user_version(&path).unwrap(), 2);
        assert!(open_database(&path).is_err());
        assert!(path.exists());
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
