// Project-wide file listing for the Cmd-P palette.
//
// Why we don't respect .gitignore:
//   .env, local.properties, *.local.json — these are exactly the files the
//   user often needs to jump to, but they're gitignored. Honouring gitignore
//   would hide them. Instead we use a fixed denylist of well-known build /
//   dependency / cache directories — the same trick Zed (file_scan_exclusions)
//   and VSCode (search.exclude) use by default.

use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use ignore::WalkBuilder;

// TTL backstop for repos that aren't being fs-watched. With a watcher the
// cache is invalidated immediately on disk change; without one (e.g. closed
// project) the entry would otherwise live forever. 60s matches the resource
// cache's staleness on the frontend.
const TTL: Duration = Duration::from_secs(60);

struct Entry {
    files: Arc<Vec<String>>,
    fetched_at: Instant,
}

fn cache() -> &'static DashMap<String, Entry> {
    static C: OnceLock<DashMap<String, Entry>> = OnceLock::new();
    C.get_or_init(DashMap::new)
}

pub fn invalidate(repo: &str) {
    cache().remove(repo);
}

// Directories we never descend into. Keep this list conservative — anything
// here is permanently invisible to the file palette.
pub fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        // dependency / package managers
        "node_modules" | "bower_components" | "vendor"
        | ".pnpm-store" | ".yarn" | ".npm" | ".pnpm" | ".bun" | ".deno"
        // VCS
        | ".git" | ".hg" | ".svn"
        // build outputs (js / rust / generic)
        | "target" | "dist" | "build" | "out" | "_build"
        | ".next" | ".nuxt" | ".svelte-kit" | ".vercel" | ".turbo" | ".astro"
        | ".output"
        // caches (js / generic)
        | ".cache" | ".parcel-cache" | ".eslintcache" | ".vite"
        | "coverage" | ".nyc_output"
        // go
        | ".gocache" | ".go-cache" | "gocache" | "go-build"
        // rust
        | ".cargo" | ".rustup"
        // python
        | ".venv" | "venv" | ".env_venv" | "__pycache__"
        | ".pytest_cache" | ".mypy_cache" | ".ruff_cache" | ".tox"
        // jvm / scala
        | ".gradle" | ".m2" | ".bloop" | ".metals" | ".bsp"
        // infra / cloud
        | ".terraform" | ".serverless" | ".firebase" | ".vagrant"
        // ios / xcode
        | "Pods" | "Carthage" | "DerivedData" | "xcuserdata"
        // editor / OS junk
        | ".idea" | ".vscode-test" | ".DS_Store"
        // cmake / clion
        | "cmake-build-debug" | "cmake-build-release"
    )
}

fn walk(repo: &str) -> Vec<String> {
    let mut out = Vec::new();
    let walker = WalkBuilder::new(repo)
        .hidden(false)         // show dotfiles — .env, .vscode/, etc. are findable
        .git_ignore(false)     // gitignored ≠ uninteresting (env files, secrets)
        .git_exclude(false)
        .git_global(false)
        .ignore(false)
        .parents(false)
        .follow_links(false)
        .filter_entry(|entry| {
            // Filter applies to every entry the walker considers — for a
            // directory, returning false prunes the whole subtree.
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            if !is_dir {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !should_skip_dir(&name)
        })
        .build();
    let root_len = repo.len() + 1;
    for entry in walker.flatten() {
        let ft = match entry.file_type() {
            Some(t) => t,
            None => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let path_str = entry.path().to_string_lossy();
        if path_str.len() <= root_len {
            continue;
        }
        out.push(path_str[root_len..].to_string());
    }
    out.sort();
    out
}

#[tauri::command]
pub async fn list_project_files(repo: String) -> Result<Vec<String>, String> {
    if let Some(hit) = cache().get(&repo) {
        if hit.fetched_at.elapsed() < TTL {
            // One clone here is unavoidable because the IPC layer will
            // serialise the Vec into JSON; but we deliberately did NOT
            // also `arc = Arc::new(files.clone())` on insert — see below.
            return Ok((*hit.files).clone());
        }
    }
    // The walk itself is CPU-bound (parallel ignore::Walk + sort). It used
    // to run synchronously on a tokio runtime thread, which on big repos
    // ties up an executor and stalls unrelated IPC.
    let repo_for_blocking = repo.clone();
    let files: Vec<String> = tauri::async_runtime::spawn_blocking(move || walk(&repo_for_blocking))
        .await
        .map_err(|e| format!("walk join: {e}"))?;
    let arc = Arc::new(files);
    cache().insert(
        repo,
        Entry { files: arc.clone(), fetched_at: Instant::now() },
    );
    Ok((*arc).clone())
}
