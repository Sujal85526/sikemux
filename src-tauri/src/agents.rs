use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize)]
pub struct AgentSession {
    id: String,
    title: String,
    mtime: u64,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Hermes,
}

/// Existing on-disk conversations for an agent. claude/codex are scoped to the
/// project cwd; hermes isn't project-scoped, so it lists all sessions.
#[tauri::command]
pub fn agent_sessions(agent: AgentKind, cwd: String) -> Vec<AgentSession> {
    match agent {
        AgentKind::Claude => claude_sessions(&cwd),
        AgentKind::Codex => codex_sessions(&cwd),
        AgentKind::Hermes => hermes_sessions(),
    }
}

fn mtime_of(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn condense(text: &str) -> Option<String> {
    let c = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if c.is_empty() || c.starts_with('<') { return None; }
    Some(c.chars().take(72).collect())
}

// ---- claude — ~/.claude/projects/<cwd-dashed>/<uuid>.jsonl --------------
fn claude_sessions(cwd: &str) -> Vec<AgentSession> {
    let Ok(home) = std::env::var("HOME") else { return Vec::new() };
    let dir = PathBuf::from(&home)
        .join(".claude/projects")
        .join(cwd.replace('/', "-"));
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        let title = claude_title(&path).unwrap_or_else(|| id.chars().take(8).collect());
        out.push(AgentSession {
            id: id.to_string(),
            title,
            mtime: mtime_of(&path),
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

fn claude_title(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(120).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") { continue; }
        let content = v.get("message").and_then(|m| m.get("content"));
        let text = match content {
            Some(c) if c.is_string() => c.as_str().unwrap_or("").to_string(),
            Some(c) if c.is_array() => c
                .as_array()
                .unwrap()
                .iter()
                .find_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        b.get("text").and_then(|t| t.as_str()).map(String::from)
                    } else { None }
                })
                .unwrap_or_default(),
            _ => continue,
        };
        if let Some(t) = condense(&text) { return Some(t); }
    }
    None
}

// ---- codex — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ----------------
fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 6 { return; }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out, depth + 1);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn codex_sessions(cwd: &str) -> Vec<AgentSession> {
    let Ok(home) = std::env::var("HOME") else { return Vec::new() };
    let mut files = Vec::new();
    collect_jsonl(&PathBuf::from(&home).join(".codex/sessions"), &mut files, 0);

    let mut out = Vec::new();
    for path in files {
        let Ok(file) = fs::File::open(&path) else { continue };
        let mut first = String::new();
        if BufReader::new(file).read_line(&mut first).is_err() { continue; }
        let Ok(v) = serde_json::from_str::<Value>(first.trim()) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") { continue; }
        let Some(payload) = v.get("payload") else { continue };
        if payload.get("cwd").and_then(|c| c.as_str()) != Some(cwd) { continue; }
        let Some(id) = payload.get("id").and_then(|i| i.as_str()) else { continue };
        let title = codex_title(&path).unwrap_or_else(|| id.chars().take(8).collect());
        out.push(AgentSession {
            id: id.to_string(),
            title,
            mtime: mtime_of(&path),
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

fn codex_title(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(200).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") { continue; }
        let payload = v.get("payload");
        if payload.and_then(|p| p.get("type")).and_then(|t| t.as_str())
            != Some("user_message")
        { continue; }
        let msg = payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("");
        if let Some(t) = condense(msg) { return Some(t); }
    }
    None
}

// ---- hermes — `sessions` table in ~/.hermes/state.db (SQLite) -----------
fn hermes_sessions() -> Vec<AgentSession> {
    let Ok(home) = std::env::var("HOME") else { return Vec::new() };
    let db = PathBuf::from(&home).join(".hermes/state.db");
    if !db.exists() { return Vec::new(); }

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
