// Watch a repo's working tree and emit `git_changed` events to the frontend
// whenever files (or `.git/index`, refs, HEAD) move. Replaces the 3s polling
// loop in GitPane. Per-repo watcher; a `repo_watch_stop` releases it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::files::WatcherChange;

fn watch_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Watch(e.to_string())
}

struct WatchHandle {
    _watcher: RecommendedWatcher,
}

const MAX_WATCH_LEASES: u16 = 1_024;
const WATCH_LEASE_LIMIT_ERROR: &str = "repo watcher lease limit reached";

struct WatchEntry<H> {
    _handle: H,
    leases: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LeaseAcquire {
    Created,
    Acquired(u16),
}

#[derive(Debug, Eq, PartialEq)]
enum LeaseAcquireError<E> {
    Limit,
    Create(E),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LeaseRelease {
    Unknown,
    Retained(u16),
    Removed,
}

struct WatchRegistry<H> {
    entries: HashMap<String, WatchEntry<H>>,
}

impl<H> Default for WatchRegistry<H> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<H> WatchRegistry<H> {
    fn acquire_or_insert<E>(
        &mut self,
        repo: String,
        create: impl FnOnce() -> Result<H, E>,
    ) -> Result<LeaseAcquire, LeaseAcquireError<E>> {
        match self.entries.entry(repo) {
            std::collections::hash_map::Entry::Occupied(mut occupied) => {
                let entry = occupied.get_mut();
                if entry.leases >= MAX_WATCH_LEASES {
                    return Err(LeaseAcquireError::Limit);
                }
                entry.leases += 1;
                Ok(LeaseAcquire::Acquired(entry.leases))
            }
            std::collections::hash_map::Entry::Vacant(vacant) => {
                let handle = create().map_err(LeaseAcquireError::Create)?;
                vacant.insert(WatchEntry {
                    _handle: handle,
                    leases: 1,
                });
                Ok(LeaseAcquire::Created)
            }
        }
    }

    fn release(&mut self, repo: &str) -> LeaseRelease {
        let Some(entry) = self.entries.get_mut(repo) else {
            return LeaseRelease::Unknown;
        };
        if entry.leases > 1 {
            entry.leases -= 1;
            return LeaseRelease::Retained(entry.leases);
        }
        self.entries.remove(repo);
        LeaseRelease::Removed
    }

    fn counts(&self) -> (usize, u64) {
        let leases = self.entries.values().fold(0_u64, |total, entry| {
            total.saturating_add(u64::from(entry.leases))
        });
        (self.entries.len(), leases)
    }
}

fn registry() -> &'static Mutex<WatchRegistry<WatchHandle>> {
    static R: OnceLock<Mutex<WatchRegistry<WatchHandle>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(WatchRegistry::default()))
}

pub fn watch_count() -> usize {
    registry()
        .lock()
        .map(|registry| registry.entries.len())
        .unwrap_or(0)
}

fn record_registry_gauges(watchers: usize, leases: u64) {
    let observer = crate::observability::global_observability();
    observer.set_gauge("fs_watch.active_watchers", watchers as f64);
    observer.set_gauge("fs_watch.active_leases", leases as f64);
}

fn increment_watch_counter(name: &'static str) {
    let _ = crate::observability::global_observability().increment_counter(name, 1);
}

#[derive(Serialize, Clone)]
struct ChangePayload {
    repo: String,
}

// 200ms debounce — fsevents on macOS fires bursts for a single save.
const DEBOUNCE_MS: u64 = 200;
const MAX_DEBOUNCE_MS: u64 = 1_000;
const EVENT_CHANNEL_CAPACITY: usize = 1_024;
const MAX_BATCH_CHANGES: usize = 512;

enum WatchMessage {
    Changes(Vec<WatcherChange>),
    Rescan,
}

fn merge_message(message: WatchMessage, changes: &mut Vec<WatcherChange>, force_rescan: &mut bool) {
    match message {
        WatchMessage::Rescan => {
            *force_rescan = true;
            changes.clear();
        }
        WatchMessage::Changes(mut incoming) if !*force_rescan => {
            if changes.len().saturating_add(incoming.len()) > MAX_BATCH_CHANGES {
                *force_rescan = true;
                changes.clear();
            } else {
                changes.append(&mut incoming);
            }
        }
        WatchMessage::Changes(_) => {}
    }
}

fn spawn_debouncer(
    app: AppHandle,
    repo: String,
    mut rx: tokio::sync::mpsc::Receiver<WatchMessage>,
    rescan_requested: Arc<AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut changes = Vec::new();
            let mut force_rescan = rescan_requested.swap(false, Ordering::AcqRel);
            merge_message(first, &mut changes, &mut force_rescan);

            let sleep = tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS));
            tokio::pin!(sleep);
            let max_sleep = tokio::time::sleep(Duration::from_millis(MAX_DEBOUNCE_MS));
            tokio::pin!(max_sleep);
            let mut closed = false;
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    _ = &mut max_sleep => break,
                    msg = rx.recv() => {
                        match msg {
                            Some(message) => {
                                merge_message(message, &mut changes, &mut force_rescan);
                                force_rescan |= rescan_requested.swap(false, Ordering::AcqRel);
                                sleep.as_mut().reset(
                                    tokio::time::Instant::now() + Duration::from_millis(DEBOUNCE_MS)
                                );
                            }
                            None => {
                                closed = true;
                                break;
                            }
                        }
                    }
                }
            }

            force_rescan |= rescan_requested.swap(false, Ordering::AcqRel);
            let repo_for_update = repo.clone();
            let update = tauri::async_runtime::spawn_blocking(move || {
                crate::files::apply_watcher_batch(&repo_for_update, changes, force_rescan);
            })
            .await;
            if update.is_err() {
                // A panicked blocking task must not leave a trusted stale
                // snapshot behind. The next palette open performs a full scan.
                crate::files::invalidate(&repo);
            }
            let _ = app.emit("git_changed", ChangePayload { repo: repo.clone() });
            if closed {
                return;
            }
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

fn should_ignore(repo: &Path, path: &Path) -> bool {
    if is_git_signal(path) {
        return false;
    }
    // Share the file-palette denylist (build artifacts, dep caches, VCS
    // metadata) so a `cargo test` / `pytest` / `npm run build` in the
    // watched repo doesn't fire thousands of fs events that all clear the
    // resource cache and re-run `git_overview`. `.DS_Store` is a file so
    // it's not covered by should_skip_dir; keep the explicit check.
    let Ok(relative) = path.strip_prefix(repo) else {
        // Let the file cache classify outside-root paths as ambiguous and use
        // its correctness-preserving full-rescan fallback.
        return false;
    };
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let name = component.as_os_str().to_string_lossy();
        if name == ".DS_Store" {
            return true;
        }
        let is_leaf = index + 1 == components.len();
        // Keep an event for the denied directory itself: an included file
        // named `target` may just have been replaced by a denied directory,
        // and the incremental cache must remove that stale file. Descendant
        // churn remains ignored.
        if crate::files::should_skip_dir(&name) && !is_leaf {
            return true;
        }
    }
    false
}

fn changes_for_event(repo: &Path, event: Event) -> Option<WatchMessage> {
    if event.need_rescan() {
        return Some(WatchMessage::Rescan);
    }
    if event.paths.len() > MAX_BATCH_CHANGES {
        return Some(WatchMessage::Rescan);
    }

    let mut changes = match event.kind {
        EventKind::Access(_) => return None,
        EventKind::Create(_) => event
            .paths
            .into_iter()
            .map(WatcherChange::Reconcile)
            .collect::<Vec<_>>(),
        EventKind::Remove(_) => event
            .paths
            .into_iter()
            .map(WatcherChange::Remove)
            .collect::<Vec<_>>(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            if event.paths.len() != 2 {
                return Some(WatchMessage::Rescan);
            }
            vec![
                WatcherChange::Remove(event.paths[0].clone()),
                WatcherChange::Reconcile(event.paths[1].clone()),
            ]
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => event
            .paths
            .into_iter()
            .map(WatcherChange::Remove)
            .collect::<Vec<_>>(),
        EventKind::Modify(ModifyKind::Name(
            RenameMode::To | RenameMode::Any | RenameMode::Other,
        ))
        | EventKind::Modify(_) => event
            .paths
            .into_iter()
            .map(WatcherChange::Reconcile)
            .collect::<Vec<_>>(),
        EventKind::Any | EventKind::Other => return Some(WatchMessage::Rescan),
    };

    if changes.is_empty() {
        return Some(WatchMessage::Rescan);
    }
    changes.retain(|change| {
        let path: &PathBuf = match change {
            WatcherChange::Reconcile(path) | WatcherChange::Remove(path) => path,
        };
        !should_ignore(repo, path)
    });
    if changes.is_empty() {
        None
    } else {
        Some(WatchMessage::Changes(changes))
    }
}

fn try_send_message(
    tx: &tokio::sync::mpsc::Sender<WatchMessage>,
    rescan_requested: &AtomicBool,
    message: WatchMessage,
) {
    if matches!(
        tx.try_send(message),
        Err(tokio::sync::mpsc::error::TrySendError::Full(_))
    ) {
        // A dropped path delta makes the whole batch untrustworthy. The
        // bounded channel already contains a wakeup, and the debouncer
        // will convert the shared flag into one complete rescan.
        rescan_requested.store(true, Ordering::Release);
    }
}

fn create_watch(app: AppHandle, repo: String) -> AppResult<WatchHandle> {
    let (tx, rx) = tokio::sync::mpsc::channel::<WatchMessage>(EVENT_CHANNEL_CAPACITY);
    let rescan_requested = Arc::new(AtomicBool::new(false));
    let callback_repo = PathBuf::from(&repo);
    let callback_rescan = rescan_requested.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let message = match res {
            Ok(event) => changes_for_event(&callback_repo, event),
            Err(_) => Some(WatchMessage::Rescan),
        };
        if let Some(message) = message {
            try_send_message(&tx, &callback_rescan, message);
        }
    })
    .map_err(watch_err)?;

    watcher
        .watch(Path::new(&repo), RecursiveMode::Recursive)
        .map_err(watch_err)?;

    // Start the consumer only after the OS watcher is live. Events produced
    // during `watch` remain bounded in the channel; a failed setup drops both
    // ends without publishing a registry entry or leaking a background task.
    spawn_debouncer(app, repo, rx, rescan_requested);
    Ok(WatchHandle { _watcher: watcher })
}

#[tauri::command]
pub fn repo_watch_start(app: AppHandle, repo: String) -> AppResult<()> {
    // The registry lock deliberately covers construction. Starts are rare,
    // and serializing them closes the check/create/insert race that could
    // otherwise produce two native event streams for one repo.
    let mut registry = registry().lock().map_err(watch_err)?;
    let acquisition =
        registry.acquire_or_insert(repo.clone(), || create_watch(app.clone(), repo.clone()));
    let counts = registry.counts();
    drop(registry);

    match acquisition {
        Ok(LeaseAcquire::Acquired(_)) => {
            increment_watch_counter("fs_watch.lease_acquires");
            record_registry_gauges(counts.0, counts.1);
            return Ok(());
        }
        Ok(LeaseAcquire::Created) => {
            increment_watch_counter("fs_watch.lease_acquires");
            increment_watch_counter("fs_watch.watcher_starts");
            record_registry_gauges(counts.0, counts.1);
        }
        Err(LeaseAcquireError::Limit) => {
            increment_watch_counter("fs_watch.lease_overflows");
            return Err(AppError::Watch(WATCH_LEASE_LIMIT_ERROR.to_owned()));
        }
        Err(LeaseAcquireError::Create(error)) => {
            increment_watch_counter("fs_watch.start_errors");
            return Err(error);
        }
    }

    // First repo-scoped synthetic emit so the frontend refreshes this project
    // after subscribing. Keep it scoped; an empty repo means "invalidate all"
    // on the JS side and causes an O(open projects) refetch storm.
    crate::files::invalidate(&repo);
    let _ = app.emit::<ChangePayload>("git_changed", ChangePayload { repo });
    Ok(())
}

#[tauri::command]
pub fn repo_watch_stop(repo: String) -> AppResult<()> {
    let mut registry = registry().lock().map_err(watch_err)?;
    let release = registry.release(&repo);
    let counts = registry.counts();
    drop(registry);

    match release {
        LeaseRelease::Unknown => {
            // Cleanup paths may race or retry, so stopping an unknown repo is
            // explicitly idempotent. Count it for lifecycle diagnostics.
            increment_watch_counter("fs_watch.stop_unknown");
        }
        LeaseRelease::Retained(_) => {
            increment_watch_counter("fs_watch.lease_releases");
            record_registry_gauges(counts.0, counts.1);
        }
        LeaseRelease::Removed => {
            increment_watch_counter("fs_watch.lease_releases");
            increment_watch_counter("fs_watch.watcher_stops");
            record_registry_gauges(counts.0, counts.1);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::Flag;

    #[test]
    fn watcher_registry_leases_reuse_one_handle_and_remove_only_at_zero() {
        let mut registry = WatchRegistry::<u8>::default();
        assert_eq!(
            registry.acquire_or_insert("repo".to_owned(), || Ok::<_, &'static str>(7)),
            Ok(LeaseAcquire::Created)
        );
        assert_eq!(
            registry.acquire_or_insert::<&'static str>("repo".to_owned(), || {
                panic!("existing watcher must not be recreated")
            }),
            Ok(LeaseAcquire::Acquired(2))
        );
        assert_eq!(registry.counts(), (1, 2));
        assert_eq!(registry.entries.get("repo").unwrap()._handle, 7);

        assert_eq!(registry.release("repo"), LeaseRelease::Retained(1));
        assert_eq!(registry.counts(), (1, 1));
        assert_eq!(registry.release("repo"), LeaseRelease::Removed);
        assert_eq!(registry.counts(), (0, 0));
        assert_eq!(registry.release("repo"), LeaseRelease::Unknown);
        assert_eq!(registry.release("repo"), LeaseRelease::Unknown);
    }

    #[test]
    fn failed_first_watcher_start_does_not_publish_a_lease() {
        let mut registry = WatchRegistry::<u8>::default();
        assert_eq!(
            registry.acquire_or_insert("repo".to_owned(), || Err("setup failed")),
            Err(LeaseAcquireError::Create("setup failed"))
        );
        assert_eq!(registry.counts(), (0, 0));

        assert_eq!(
            registry.acquire_or_insert("repo".to_owned(), || Ok::<_, &'static str>(9)),
            Ok(LeaseAcquire::Created)
        );
        assert_eq!(registry.counts(), (1, 1));
    }

    #[test]
    fn watcher_lease_overflow_is_rejected_without_mutation() {
        let mut registry = WatchRegistry::<u8>::default();
        registry
            .acquire_or_insert("repo".to_owned(), || Ok::<_, &'static str>(11))
            .unwrap();
        registry.entries.get_mut("repo").unwrap().leases = MAX_WATCH_LEASES;

        assert_eq!(
            registry.acquire_or_insert("repo".to_owned(), || Ok::<_, &'static str>(12)),
            Err(LeaseAcquireError::Limit)
        );
        let entry = registry.entries.get("repo").unwrap();
        assert_eq!(entry.leases, MAX_WATCH_LEASES);
        assert_eq!(entry._handle, 11);
    }

    #[test]
    fn paired_rename_preserves_source_remove_and_target_reconcile() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("before.txt");
        let target = temp.path().join("after.txt");
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(source.clone())
            .add_path(target.clone());

        let Some(WatchMessage::Changes(changes)) = changes_for_event(temp.path(), event) else {
            panic!("paired rename should produce incremental changes");
        };
        assert_eq!(changes.len(), 2);
        assert!(matches!(
            &changes[0],
            WatcherChange::Remove(path) if path == &source
        ));
        assert!(matches!(
            &changes[1],
            WatcherChange::Reconcile(path) if path == &target
        ));
    }

    #[test]
    fn denied_subtrees_are_ignored_but_git_signals_are_retained() {
        let temp = tempfile::tempdir().unwrap();
        let denied_root = temp.path().join("target");
        let denied_root_event =
            Event::new(EventKind::Create(notify::event::CreateKind::Folder)).add_path(denied_root);
        assert!(matches!(
            changes_for_event(temp.path(), denied_root_event),
            Some(WatchMessage::Changes(_))
        ));

        let denied = temp.path().join("target/debug/output");
        let denied_event =
            Event::new(EventKind::Create(notify::event::CreateKind::File)).add_path(denied);
        assert!(changes_for_event(temp.path(), denied_event).is_none());

        let git_index = temp.path().join(".git/index");
        let git_event = Event::new(EventKind::Modify(ModifyKind::Any)).add_path(git_index.clone());
        let Some(WatchMessage::Changes(changes)) = changes_for_event(temp.path(), git_event) else {
            panic!("git index should remain a git refresh signal");
        };
        assert!(matches!(
            &changes[0],
            WatcherChange::Reconcile(path) if path == &git_index
        ));
    }

    #[test]
    fn notify_rescan_flag_forces_a_complete_rescan() {
        let temp = tempfile::tempdir().unwrap();
        let event = Event::new(EventKind::Any).set_flag(Flag::Rescan);
        assert!(matches!(
            changes_for_event(temp.path(), event),
            Some(WatchMessage::Rescan)
        ));
    }

    #[test]
    fn oversized_debounce_batch_collapses_to_one_rescan() {
        let incoming = (0..=MAX_BATCH_CHANGES)
            .map(|index| WatcherChange::Remove(PathBuf::from(format!("file-{index}"))))
            .collect();
        let mut changes = Vec::new();
        let mut force_rescan = false;

        merge_message(
            WatchMessage::Changes(incoming),
            &mut changes,
            &mut force_rescan,
        );

        assert!(force_rescan);
        assert!(changes.is_empty());
    }
}
