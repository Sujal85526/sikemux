// Watch a repo's working tree and emit `git_changed` events to the frontend
// whenever files (or `.git/index`, refs, HEAD) move. Replaces the 3s polling
// loop in GitPane. Per-repo watcher; a `repo_watch_stop` releases it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

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

// Monotonic anchor for debounce math — process-start Instant, so deltas in
// millis are immune to wall-clock jumps (NTP, sleep/resume, DST).
fn epoch() -> Instant {
    static E: OnceLock<Instant> = OnceLock::new();
    *E.get_or_init(Instant::now)
}

#[derive(Serialize, Clone)]
struct ChangePayload {
    repo: String,
}

// 200ms debounce — fsevents on macOS fires bursts for a single save.
const DEBOUNCE_MS: u64 = 200;

fn debounce_emit(app: &AppHandle, repo: &str, last_emit: &Arc<AtomicU64>) {
    let now_mono = epoch().elapsed().as_millis() as u64;
    let prev = last_emit.load(Ordering::Relaxed);
    if now_mono.saturating_sub(prev) < DEBOUNCE_MS {
        return;
    }
    last_emit.store(now_mono, Ordering::Relaxed);
    // File list for the Cmd-P palette is stale now — drop the cache so the
    // next palette open rewalks. Cheap; the walk itself is debounced behind
    // user interaction.
    crate::files::invalidate(repo);
    let _ = app.emit(
        "git_changed",
        ChangePayload { repo: repo.to_string() },
    );
}

fn should_ignore(path: &Path) -> bool {
    // Skip noisy non-repo paths: target/, node_modules/, dist/. We can't know
    // the user's full ignore list, but these three cover ~99% of churn.
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s == "target" || s == "node_modules" || s == "dist" || s == ".DS_Store"
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

    let app_clone = app.clone();
    let repo_clone = repo.clone();
    let last_emit = Arc::new(AtomicU64::new(0));
    let last_clone = last_emit.clone();

    let mut watcher = notify::recommended_watcher(
        move |res: notify::Result<Event>| {
            let Ok(event) = res else { return };
            let interesting = matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            );
            if !interesting { return; }
            if event.paths.iter().all(|p| should_ignore(p)) { return; }
            debounce_emit(&app_clone, &repo_clone, &last_clone);
        },
    )
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
    let _ = app.emit::<ChangePayload>("git_changed", ChangePayload { repo });
    Ok(())
}

#[tauri::command]
pub fn repo_watch_stop(repo: String) -> AppResult<()> {
    registry().lock().map_err(watch_err)?.remove(&repo);
    Ok(())
}
