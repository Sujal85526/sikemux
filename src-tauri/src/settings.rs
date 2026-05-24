// Backend bits for the settings page:
//   - scan_project_roots: walks each configured root one level deep and
//     returns the project candidates. A root with a `.git` dir is itself a
//     project; otherwise its immediate subdirs are.
//   - expand_path: resolves `~` against $HOME on the Rust side so we don't
//     have to do that dance in the renderer.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
pub struct ProjectEntry {
    name: String,
    path: String,
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

#[tauri::command]
pub fn expand_path(path: String) -> String {
    expand(&path).to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn scan_project_roots(roots: Vec<String>) -> Vec<ProjectEntry> {
    let mut out: Vec<ProjectEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for raw in roots {
        let root = expand(&raw);
        if !root.is_dir() {
            continue;
        }
        // Always include the root itself — `.git` is not required (a brand
        // new project before `git init` should still be reachable).
        let root_path = root.to_string_lossy().into_owned();
        if seen.insert(root_path.clone()) {
            out.push(ProjectEntry { name: name_of(&root), path: root_path });
        }
        // Also enumerate immediate subdirs so a directory of projects works
        // (e.g. ~/proj/pers → sikemux, foo, bar). Dotfile dirs are skipped.
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() { continue; }
            let name = name_of(&p);
            if name.starts_with('.') { continue; }
            let path = p.to_string_lossy().into_owned();
            if seen.insert(path.clone()) {
                out.push(ProjectEntry { name, path });
            }
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}
