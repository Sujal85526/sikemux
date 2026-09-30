use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use tokio::process::Command;

use super::recent::{Found, Hit, Listed, PageScan};
use crate::agents::executable::apply_login_environment;
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

/// Hermes records the folder each session ran in, so the page asks only for these projects.
pub(super) fn hermes_recent(scan: &PageScan<'_>) -> Vec<Hit> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    let db = PathBuf::from(&home).join(".hermes/state.db");
    let Ok(conn) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let projects: Vec<&String> = scan.projects().collect();
    if projects.is_empty() {
        return Vec::new();
    }
    let placeholders = vec!["?"; projects.len()].join(", ");
    let sql = format!(
        "SELECT id, \
         COALESCE(NULLIF(TRIM(title), ''), substr(id, 1, 13)) AS title, \
         CAST(COALESCE(started_at, 0) AS INTEGER) AS mtime, \
         cwd \
         FROM sessions WHERE cwd IN ({placeholders})"
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(projects), |row| {
        Ok(Found {
            project: row.get::<_, String>(3)?,
            session: AgentSession {
                id: row.get::<_, String>(0)?,
                title: row.get::<_, String>(1)?,
                mtime: row.get::<_, i64>(2).unwrap_or(0).max(0) as u64,
            },
        })
    }) else {
        return Vec::new();
    };
    let listed = rows
        .filter_map(Result::ok)
        .map(|found| Listed {
            at_ms: found.session.mtime * 1000,
            key: found.session.id.clone(),
            item: found,
        })
        .collect();
    scan.collect(listed, |found| Some(found.clone()))
}

const HERMES_RENAME_TIMEOUT: Duration = Duration::from_secs(30);

/// Renames through Hermes's own command, which keeps titles unique and marks the
/// name as the user's so generated titles never replace it.
pub(super) async fn rename_hermes_session(
    executable: &Path,
    session_id: &str,
    name: &str,
) -> Result<(), String> {
    let mut command = Command::new(executable);
    apply_login_environment(&mut command);
    command
        .args(["sessions", "rename", "--", session_id, name])
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null());
    let output = tokio::time::timeout(HERMES_RENAME_TIMEOUT, command.output())
        .await
        .map_err(|_| "Hermes took too long to rename the chat".to_string())?
        .map_err(|_| "Could not start Hermes".to_string())?;
    if output.status.success() {
        return Ok(());
    }
    // Hermes prints why it refused, such as a title already in use, on stdout.
    let printed = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let reason = printed
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("unknown error");
    Err(format!(
        "Hermes could not rename the chat: {}",
        reason.trim_start_matches("Error: ")
    ))
}
