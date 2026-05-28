// Backend bits for the settings page:
//   - scan_project_roots: each configured root is always emitted as a
//     candidate (a brand-new project before `git init` should still be
//     reachable). Subdirectories within the configured `depth` are
//     emitted ONLY if they are git repos — and the walk does not descend
//     INTO a git repo (its inner src/, vendor/, etc. shouldn't pollute
//     the picker). Dotfile dirs are skipped at every level.
//   - expand_path: resolves `~` against $HOME on the Rust side.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct ProjectEntry {
    name: String,
    path: String,
}

#[derive(Deserialize)]
pub struct ProjectRoot {
    path: String,
    #[serde(default = "default_depth")]
    depth: i64,
}

fn default_depth() -> i64 {
    1
}

fn expand(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    if path == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(path)
}

fn name_of(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned())
}

fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

#[tauri::command]
pub fn expand_path(path: String) -> String {
    expand(&path).to_string_lossy().into_owned()
}

// DFS within `root` up to `remaining` levels deep. The root is always
// emitted by the caller. Within the walk, only git repos are emitted;
// repos are also terminal — we never descend into one.
fn walk(
    dir: &Path,
    remaining: i64,
    out: &mut Vec<ProjectEntry>,
    seen: &mut std::collections::HashSet<String>,
) {
    if remaining <= 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = name_of(&p);
        if name.starts_with('.') {
            continue;
        }
        if is_repo(&p) {
            let path = p.to_string_lossy().into_owned();
            if seen.insert(path.clone()) {
                out.push(ProjectEntry { name, path });
            }
            // Terminal — repos don't get their innards scanned.
            continue;
        }
        walk(&p, remaining - 1, out, seen);
    }
}

#[tauri::command]
pub async fn scan_project_roots(roots: Vec<ProjectRoot>) -> Vec<ProjectEntry> {
    let mut out: Vec<ProjectEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for r in roots {
        let root = expand(&r.path);
        if !root.is_dir() {
            continue;
        }
        // Always include the root itself — even non-repo directories the
        // user has explicitly configured as roots are valid project
        // candidates (pre-init projects, scratch dirs, etc.).
        let root_path = root.to_string_lossy().into_owned();
        if seen.insert(root_path.clone()) {
            out.push(ProjectEntry {
                name: name_of(&root),
                path: root_path,
            });
        }
        // If the root itself is a git repo, don't enumerate its insides
        // — it's already the project.
        if is_repo(&root) {
            continue;
        }
        walk(&root, r.depth.max(0), &mut out, &mut seen);
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}
