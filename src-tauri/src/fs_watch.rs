// Watch a repo's working tree and emit `git_changed` events to the frontend
// whenever files (or `.git/index`, refs, HEAD) move. Replaces the 3s polling
// loop in GitPane. Per-repo watcher; a `repo_watch_stop` releases it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

fn watch_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Watch(e.to_string())
}

struct WatchHandle {
    _watcher: RecommendedWatcher,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<WatchHandle>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<WatchHandle>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn watch_count() -> usize {
    registry().lock().map(|r| r.len()).unwrap_or(0)
}

#[derive(Serialize, Clone)]
struct ChangePayload {
    repo: String,
}

// 200ms debounce — fsevents on macOS fires bursts for a single save.
const DEBOUNCE_MS: u64 = 200;

fn spawn_debouncer(app: AppHandle, repo: String, mut rx: tokio::sync::mpsc::UnboundedReceiver<()>) {
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            let sleep = tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS));
            tokio::pin!(sleep);
            let mut closed = false;
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    msg = rx.recv() => {
                        if msg.is_none() {
                            closed = true;
                            break;
                        }
                        sleep
                            .as_mut()
                            .reset(tokio::time::Instant::now() + Duration::from_millis(DEBOUNCE_MS));
                    }
                }
            }
            if closed {
                return;
            }
            // File list for the Cmd-P palette is stale now — drop the cache
            // so the next palette open rewalks. Cheap; the walk itself is
            // debounced behind user interaction.
            crate::files::invalidate(&repo);
            let _ = app.emit("git_changed", ChangePayload { repo: repo.clone() });
        }
    });
}

fn is_git_signal(path: &Path) -> bool {
    let mut after_git = false;
    for c in path.components() {
        let s = c.as_os_str().to_string_lossy();
        if !after_git {
            if s == ".git" {
                after_git = true;
            }
            continue;
        }
        return matches!(
            s.as_ref(),
            "HEAD"
                | "index"
                | "packed-refs"
                | "MERGE_HEAD"
                | "REBASE_HEAD"
                | "CHERRY_PICK_HEAD"
                | "BISECT_LOG"
                | "refs"
                | "logs"
                | "rebase-merge"
                | "rebase-apply"
        );
    }
    false
}

fn should_ignore(path: &Path) -> bool {
    if is_git_signal(path) {
        return false;
    }
    // Share the file-palette denylist (build artifacts, dep caches, VCS
    // metadata) so a `cargo test` / `pytest` / `npm run build` in the
    // watched repo doesn't fire thousands of fs events that all clear the
    // resource cache and re-run `git_overview`. `.DS_Store` is a file so
    // it's not covered by should_skip_dir; keep the explicit check.
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        if s == ".DS_Store" {
            return true;
        }
        crate::files::should_skip_dir(&s)
    })
}

#[tauri::command]
pub fn repo_watch_start(app: AppHandle, repo: String) -> AppResult<()> {
    {
        let reg = registry().lock().map_err(watch_err)?;
        if reg.contains_key(&repo) {
            return Ok(());
        }
    }

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    spawn_debouncer(app.clone(), repo.clone(), rx);

    let tx_events = tx.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        let interesting = matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
        );
        if !interesting {
            return;
        }
        if event.paths.iter().all(|p| should_ignore(p)) {
            return;
        }
        let _ = tx_events.send(());
    })
    .map_err(watch_err)?;

    watcher
        .watch(Path::new(&repo), RecursiveMode::Recursive)
        .map_err(watch_err)?;

    registry()
        .lock()
        .map_err(watch_err)?
        .insert(repo.clone(), Arc::new(WatchHandle { _watcher: watcher }));

    // First repo-scoped synthetic emit so the frontend refreshes this project
    // after subscribing. Keep it scoped; an empty repo means "invalidate all"
    // on the JS side and causes an O(open projects) refetch storm.
    crate::files::invalidate(&repo);
    let _ = app.emit::<ChangePayload>("git_changed", ChangePayload { repo });
    Ok(())
}

#[tauri::command]
pub fn repo_watch_stop(repo: String) -> AppResult<()> {
    registry().lock().map_err(watch_err)?.remove(&repo);
    Ok(())
}
