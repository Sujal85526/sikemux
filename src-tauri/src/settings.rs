// Backend bits for the settings page:
//   - scan_project_roots: exact pinned projects are always emitted when
//     they exist. Discovery roots emit the root itself only when it is a
//     git repo; subdirectories within the configured `depth` are emitted
//     ONLY if they are git repos — and the walk does not descend INTO a
//     git repo (its inner src/, vendor/, etc. shouldn't pollute the
//     picker). Dotfile dirs are skipped at every level.
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

#[derive(Deserialize)]
pub struct PinnedProject {
    path: String,
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

fn relative_name(root: &Path, p: &Path) -> String {
    let Ok(rel) = p.strip_prefix(root) else {
        return name_of(p);
    };
    if rel.as_os_str().is_empty() {
        return name_of(p);
    }
    let s = rel
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    if s.is_empty() {
        name_of(p)
    } else {
        s
    }
}

fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

#[tauri::command]
pub fn expand_path(path: String) -> String {
    expand(&path).to_string_lossy().into_owned()
}

#[tauri::command]
pub fn is_directory(path: String) -> bool {
    expand(&path).is_dir()
}

// DFS within `root` up to `remaining` levels deep. Within the walk, only
// git repos are emitted; repos are also terminal — we never descend into
// one.
fn walk(
    root: &Path,
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
                out.push(ProjectEntry {
                    name: relative_name(root, &p),
                    path,
                });
            }
            // Terminal — repos don't get their innards scanned.
            continue;
        }
        walk(root, &p, remaining - 1, out, seen);
    }
}

#[tauri::command]
pub async fn scan_project_roots(
    pinned_projects: Vec<PinnedProject>,
    roots: Vec<ProjectRoot>,
) -> Vec<ProjectEntry> {
    let mut out: Vec<ProjectEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for p in pinned_projects {
        let project = expand(&p.path);
        if !project.is_dir() {
            continue;
        }
        let path = project.to_string_lossy().into_owned();
        if seen.insert(path.clone()) {
            out.push(ProjectEntry {
                name: name_of(&project),
                path,
            });
        }
    }

    for r in roots {
        let root = expand(&r.path);
        if !root.is_dir() {
            continue;
        }
        if is_repo(&root) {
            let root_path = root.to_string_lossy().into_owned();
            if seen.insert(root_path.clone()) {
                out.push(ProjectEntry {
                    name: name_of(&root),
                    path: root_path,
                });
            }
            // If the root itself is a git repo, don't enumerate its
            // insides — it's already the project.
            continue;
        }
        walk(&root, &root, r.depth.max(0), &mut out, &mut seen);
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}
