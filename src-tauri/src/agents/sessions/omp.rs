use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde_json::Value;

use super::claude::{CLAUDE_HEAD_BYTES, CLAUDE_TAIL_BYTES};
use super::{
    cached_title, collect_jsonl, condense, mtime_of, read_prefix, read_suffix, text_from_content,
    title_cache_stamp, MAX_AGENT_TRANSCRIPTS_INSPECTED,
};
use crate::agents::config::omp_session_dirs;
use crate::agents::AgentSession;

pub(super) fn omp_sessions(cwd: &str) -> Vec<AgentSession> {
    omp_sessions_from_dirs(cwd, omp_session_dirs())
}

fn omp_sessions_from_dirs(cwd: &str, roots: Vec<PathBuf>) -> Vec<AgentSession> {
    let mut files = Vec::new();
    for root in roots {
        collect_jsonl(&root, &mut files, 0);
    }
    files.sort_unstable_by_key(|path| std::cmp::Reverse(mtime_of(path)));
    files.dedup();
    files.truncate(MAX_AGENT_TRANSCRIPTS_INSPECTED);

    let mut out: Vec<AgentSession> = files
        .par_iter()
        .filter_map(|path| {
            let file = fs::File::open(path).ok()?;
            let header = BufReader::new(file)
                .lines()
                .take(40)
                .map_while(Result::ok)
                .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
                .find(|value| value.get("type").and_then(Value::as_str) == Some("session"))?;
            if header.get("cwd").and_then(Value::as_str) != Some(cwd) {
                return None;
            }
            let mtime = mtime_of(path);
            let title = cached_title(path, title_cache_stamp(path), || omp_title(path))
                .or_else(|| {
                    header
                        .get("title")
                        .and_then(Value::as_str)
                        .and_then(condense)
                })
                .or_else(|| header.get("id").and_then(Value::as_str).and_then(condense))
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|name| name.to_str())
                        .unwrap_or("session")
                        .chars()
                        .take(13)
                        .collect()
                });
            Some(AgentSession {
                id: path.to_string_lossy().into_owned(),
                title,
                mtime,
            })
        })
        .collect();
    out.sort_by_key(|item| std::cmp::Reverse(item.mtime));
    out
}

fn scan_omp_line(line: &str, named: &mut Option<String>, first_user: &mut Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("title" | "session_info") => {
            if let Some(title) = value
                .get("title")
                .or_else(|| value.get("name"))
                .and_then(Value::as_str)
                .and_then(condense)
            {
                *named = Some(title);
            }
        }
        Some("session") if named.is_none() => {
            *named = value
                .get("title")
                .and_then(Value::as_str)
                .and_then(condense);
        }
        Some("message") if first_user.is_none() => {
            let Some(message) = value.get("message") else {
                return;
            };
            if message.get("role").and_then(Value::as_str) == Some("user") {
                *first_user = message
                    .get("content")
                    .and_then(text_from_content)
                    .and_then(|text| condense(&text));
            }
        }
        _ => {}
    }
}

fn omp_title(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut named = None;
    let mut first_user = None;
    let head = read_prefix(&mut file, CLAUDE_HEAD_BYTES.min(len))?;
    for line in head.lines() {
        scan_omp_line(line, &mut named, &mut first_user);
    }
    if len > CLAUDE_HEAD_BYTES {
        if let Some(tail) = read_suffix(&mut file, len.saturating_sub(CLAUDE_TAIL_BYTES)) {
            for line in tail.lines().skip(1) {
                scan_omp_line(line, &mut named, &mut first_user);
            }
        }
    }
    named.or(first_user)
}

#[cfg(test)]
mod tests {
    use super::{omp_sessions_from_dirs, omp_title};
    use std::io::Write;

    #[test]
    fn omp_title_prefers_the_latest_explicit_name() {
        let mut transcript = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            transcript,
            "{}",
            serde_json::json!({"type":"title","title":"Initial title"})
        )
        .unwrap();
        writeln!(
            transcript,
            "{}",
            serde_json::json!({"type":"session","id":"session-1","cwd":"/repo"})
        )
        .unwrap();
        writeln!(
            transcript,
            "{}",
            serde_json::json!({"type":"message","message":{"role":"user","content":"Fallback prompt"}})
        )
        .unwrap();
        writeln!(
            transcript,
            "{}",
            serde_json::json!({"type":"title","title":"Renamed session"})
        )
        .unwrap();
        transcript.flush().unwrap();

        assert_eq!(
            omp_title(transcript.path()).as_deref(),
            Some("Renamed session")
        );
    }

    #[test]
    fn omp_session_listing_accepts_title_before_header() {
        let root = tempfile::tempdir().unwrap();
        let transcript = root.path().join("session.jsonl");
        std::fs::write(
            &transcript,
            concat!(
                "{\"type\":\"title\",\"title\":\"Ship OMP support\"}\n",
                "{\"type\":\"session\",\"id\":\"session-1\",\"cwd\":\"/repo\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"Fallback\"}}\n"
            ),
        )
        .unwrap();

        let sessions = omp_sessions_from_dirs("/repo", vec![root.path().to_path_buf()]);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, transcript.to_string_lossy());
        assert_eq!(sessions[0].title, "Ship OMP support");
    }
}
