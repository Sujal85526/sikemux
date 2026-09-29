use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags};

use crate::agents::AgentSession;

// ---- hermes — `sessions` table in ~/.hermes/state.db (SQLite) -----------
pub(super) fn hermes_sessions() -> Vec<AgentSession> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    let db = PathBuf::from(&home).join(".hermes/state.db");
    if !db.exists() {
        return Vec::new();
    }

    let conn = match Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut stmt = match conn.prepare(
        "SELECT id, \
         COALESCE(NULLIF(TRIM(title), ''), substr(id, 1, 13)) AS title, \
         CAST(COALESCE(started_at, 0) AS INTEGER) AS mtime \
         FROM sessions ORDER BY started_at DESC LIMIT 400",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |row| {
        Ok(AgentSession {
            id: row.get::<_, String>(0)?,
            title: row.get::<_, String>(1)?,
            mtime: row.get::<_, i64>(2).unwrap_or(0) as u64,
        })
    });
    match rows {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}
