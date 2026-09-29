use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde_json::Value;

use super::{
    cached_title, collect_jsonl, condense, mtime_of, text_from_content, title_cache_stamp,
    MAX_AGENT_TRANSCRIPTS_INSPECTED,
};
use crate::agents::AgentSession;

// ---- pi — ~/.pi/agent/sessions/**/<session>.jsonl ----------------------
pub(in crate::agents) fn pi_session_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_SESSION_DIR") {
        return Some(PathBuf::from(dir));
    }
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        return Some(PathBuf::from(dir).join("sessions"));
    }
    std::env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(".pi/agent/sessions"))
}

pub(super) fn pi_sessions(cwd: &str) -> Vec<AgentSession> {
    let Some(root) = pi_session_dir() else {
        return Vec::new();
    };
    let mut files = Vec::new();
    collect_jsonl(&root, &mut files, 0);
    files.sort_unstable_by_key(|path| std::cmp::Reverse(mtime_of(path)));
    files.truncate(MAX_AGENT_TRANSCRIPTS_INSPECTED);

    let mut out: Vec<AgentSession> = files
        .par_iter()
        .filter_map(|path| {
            let file = fs::File::open(path).ok()?;
            let mut first = String::new();
            BufReader::new(file).read_line(&mut first).ok()?;
            let v = serde_json::from_str::<Value>(first.trim()).ok()?;
            if v.get("type").and_then(|t| t.as_str()) != Some("session") {
                return None;
            }
            if v.get("cwd").and_then(|c| c.as_str()) != Some(cwd) {
                return None;
            }
            let id = path.to_string_lossy().to_string();
            let mtime = mtime_of(path);
            let title = cached_title(path, title_cache_stamp(path), || pi_title(path))
                .or_else(|| v.get("id").and_then(|i| i.as_str()).and_then(condense))
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("session")
                        .chars()
                        .take(13)
                        .collect()
                });
            Some(AgentSession { id, title, mtime })
        })
        .collect();
    out.sort_by_key(|item| std::cmp::Reverse(item.mtime));
    out
}

fn pi_title(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut first_user: Option<String> = None;
    let mut named: Option<String> = None;
    for line in BufReader::new(file).lines().take(220).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session_info") => {
                if let Some(name) = v.get("name").and_then(|n| n.as_str()).and_then(condense) {
                    named = Some(name);
                }
            }
            Some("message") if first_user.is_none() => {
                let Some(message) = v.get("message") else {
                    continue;
                };
                if message.get("role").and_then(|r| r.as_str()) != Some("user") {
                    continue;
                }
                if let Some(text) = message
                    .get("content")
                    .and_then(text_from_content)
                    .and_then(|t| condense(&t))
                {
                    first_user = Some(text);
                }
            }
            _ => {}
        }
    }
    named.or(first_user)
}
