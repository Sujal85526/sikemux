// PTY layer that scales to 100s of concurrent shells without saturating the
// webview's WebGL context budget.
//
// Architecture:
//
//   * Every PTY in Rust owns a `vt100::Parser` — a headless terminal
//     emulator that maintains the current screen grid + scrollback as
//     bytes arrive. A cell is 32 bytes, so the cost is the grid: a few
//     MB per PTY, and less once it drops to the idle scrollback. No
//     rendering, no DOM, no GPU, always up to date whether or not
//     anyone is looking.
//
//   * The PTY can have ZERO, ONE, or MANY subscribers. A subscriber is a
//     Tauri raw-bytes `Channel` registered by the frontend when a
//     TerminalPane mounts an xterm. When the pane unmounts (user
//     switched away) the subscriber is dropped — the PTY keeps running
//     in the background, parser keeps grid up to date, nothing is lost.
//     On re-focus the pane calls `pty_attach`, which hands back an ANSI
//     dump of the current grid + scrollback and subscribes for live
//     output in one atomic step.
//
//   * Result: the only live xterm + WebGL contexts in the app are the
//     ones the user is actually looking at.
//
// Commands surfaced to the frontend:
//
//   pty_spawn       — create a new PTY, returns ptyId
//   task_spawn      — run one non-interactive task in a durable PTY
//   pty_attach      — atomic snapshot + subscribe; returns { subId, snapshot }
//   pty_subscribe   — attach a Channel to a PTY, returns subId
//                     (kept for cases where the caller already has the
//                      screen state from a prior attach — e.g. theme reload)
//   pty_unsubscribe — detach a Channel by subId
//   pty_write       — send bytes to the PTY's stdin
//   pty_resize      — change rows/cols (also resizes the parser)
//   pty_kill        — terminate the PTY process

pub(crate) mod agent_state;
pub(crate) mod attach;
pub(crate) mod io;
mod launch;
pub(crate) mod output;
pub(crate) mod process;
mod screen;
mod shell;
mod shell_protocol;
pub(crate) mod spawn;
mod sweeper;
pub(crate) mod task;

pub(crate) use launch::OPTIONAL_PTY_ENV;

use std::collections::HashMap;
#[cfg(unix)]
use std::fs::File;
#[cfg(windows)]
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;
#[cfg(windows)]
use portable_pty::MasterPty;
use portable_pty::{Child, PtySize};
use tauri::AppHandle;
#[cfg(unix)]
use tokio::io::unix::AsyncFd;

use crate::agent_detection::{AgentKind, ManifestRegistry};
use crate::error::{AppError, AppResult};

use output::Subscriber;
use process::{child_process_id, kill_and_reap_child, terminate_process_tree, DRAIN_GRACE};
use screen::SemanticParser;
use shell::ShellLaunchIntegration;
use task::{
    notify_task_process_exited, should_signal_process_on_drain, task_process_needs_force_backstop,
    TaskExitReporter,
};

fn pty_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Pty(e.to_string())
}

/// One running pseudo-terminal: the master fd + child + headless parser +
/// the set of frontend Channels currently subscribed to live output.
///
/// I/O model: the master fd is set non-blocking and wrapped in a SINGLE
/// `AsyncFd`. The reader tokio task awaits its `readable()` side; every
/// `pty_write` awaits its `writable()` side under `write_lock` so writes
/// never block a worker thread and never interleave. We therefore hold
/// exactly one fd per PTY (down from three: master + read-dup + write-dup)
/// — see `pty_spawn` for how the lone dup keeps the child's controlling
/// terminal alive after portable_pty's `MasterPty` is dropped.
struct Pty {
    id: u32,
    app: AppHandle,
    /// The PTY master as one non-blocking fd, servicing both directions.
    /// Resize is an ioctl straight on this fd (see `pty_resize`).
    #[cfg(unix)]
    io: AsyncFd<File>,
    /// Serialises concurrent writers so two `pty_write`s can't interleave
    /// bytes on the shared fd. Reads need no guard — only the reader task
    /// reads.
    #[cfg(unix)]
    write_lock: tokio::sync::Mutex<()>,
    /// ConPTY exposes separate blocking pipe handles. They stay behind a
    /// platform boundary so Unix keeps its single-fd async fast path.
    #[cfg(windows)]
    master: Mutex<Box<dyn MasterPty + Send>>,
    #[cfg(windows)]
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Tracks the current screen grid + scrollback. Always up to date,
    /// even when no one's subscribed — that's the whole point.
    parser: Mutex<SemanticParser>,
    /// True when this shell opted into OSC 7/133 reporting. The sweeper uses
    /// it to skip taking the parser lock on every other PTY four times a second.
    shell_protocol: bool,
    /// Live xterm subscribers. Empty = PTY runs invisibly.
    /// Each chunk crosses the IPC as raw bytes, so JS receives an
    /// ArrayBuffer instead of a JSON array of numbers.
    subscribers: Mutex<HashMap<u32, Subscriber>>,
    /// Signalled by `pty_ack` whenever a renderer reports progress. The reader
    /// waits on this while a subscriber is too far behind.
    flow_control: tokio::sync::Notify,
    /// Millis-since-process-start of the last chunk processed. The idle
    /// sweeper reads this without contending with the reader because it's
    /// an atomic, not a Mutex.
    last_activity_ms: AtomicU64,
    /// Set true once the sweeper has reseeded the parser at the smaller
    /// scrollback so we don't repeatedly rebuild a parser that's already
    /// at idle size. Cleared on any new activity.
    trimmed: AtomicBool,
    /// Present only for agent PTYs. Activity is inferred natively so it
    /// remains observable after the heavyweight xterm renderer detaches.
    activity_key: Option<String>,
    agent_kind: Option<AgentKind>,
    activity_armed: AtomicBool,
    activity_state: AtomicU8,
    /// Explicit frontend teardown must not masquerade as a natural provider
    /// exit after a replacement PTY has already started.
    report_exit: AtomicBool,
    last_published_fingerprint: AtomicU64,
    idle_confirmations: AtomicU8,
    /// Advances whenever submitted input or parsed output changes the
    /// semantic evidence. Combined with screen/title contents below to make
    /// settled detection edge-triggered instead of a perpetual 4 Hz rescan.
    activity_revision: AtomicU64,
    last_detection_fingerprint: AtomicU64,
    /// `activity_revision` as of the last completed detection scan. Unchanged
    /// means the screen is unchanged, so there is nothing new to read.
    last_detection_revision: AtomicU64,
    /// Present only for a durable task PTY. The atomic gate makes natural
    /// exit, explicit kill, and app drain race to one channel delivery.
    task_exit: Option<TaskExitReporter>,
    harness_output: Mutex<crate::harness::OutputLog>,
    harness_output_pending: Arc<AtomicBool>,
    /// Monotonic task completion timestamp. Zero means the task is still
    /// running; completed task snapshots remain attachable for a fixed grace.
    task_exited_at_ms: AtomicU64,
    /// Keeps any per-process shell startup files alive for exactly as long as
    /// the PTY. `TempDir` removes them automatically; user dotfiles are never
    /// written or replaced.
    _shell_integration: Option<ShellLaunchIntegration>,
    /// Acquired before allocating an OS PTY and released only after the last
    /// native owner drops. This counts launch and reap windows where resources
    /// exist but no entry is currently published in the manager map.
    _capacity_permit: PtyCapacityPermit,
}

#[derive(Debug)]
struct PtyCapacity {
    active: AtomicUsize,
    limit: usize,
}

impl PtyCapacity {
    fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            active: AtomicUsize::new(0),
            limit,
        })
    }

    fn try_acquire(self: &Arc<Self>) -> AppResult<PtyCapacityPermit> {
        let mut active = self.active.load(Ordering::Acquire);
        loop {
            if active >= self.limit {
                return Err(AppError::Pty("PTY capacity reached".into()));
            }
            match self.active.compare_exchange_weak(
                active,
                active + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Ok(PtyCapacityPermit {
                        capacity: self.clone(),
                    });
                }
                Err(current) => active = current,
            }
        }
    }
}

#[derive(Debug)]
struct PtyCapacityPermit {
    capacity: Arc<PtyCapacity>,
}

impl Drop for PtyCapacityPermit {
    fn drop(&mut self) {
        let previous = self.capacity.active.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "PTY capacity permit underflow");
    }
}

/// All live PTYs, keyed by an id handed back to the frontend.
pub struct PtyManager {
    ptys: DashMap<u32, Arc<Pty>>,
    capacity: Arc<PtyCapacity>,
    detection_registry: RwLock<ManifestRegistry>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            ptys: DashMap::new(),
            capacity: PtyCapacity::new(MAX_ACTIVE_PTYS),
            detection_registry: RwLock::new(
                ManifestRegistry::bundled().expect("bundled agent manifests must be valid"),
            ),
        }
    }
}

impl PtyManager {
    pub fn counts(&self) -> (usize, usize) {
        let mut subscribers = 0usize;
        for entry in self.ptys.iter() {
            if let Ok(subs) = entry.value().subscribers.lock() {
                subscribers += subs.len();
            }
        }
        (self.ptys.len(), subscribers)
    }

    /// Tear down every live PTY: SIGTERM each child's process group, allow a
    /// brief grace window for well-behaved programs (editors, agents, builds)
    /// to catch the signal and clean up, then SIGKILL whatever's left and reap
    /// it. Called from the window-close hook, the reload hook, AND the
    /// `RunEvent::Exit` hook — so no exit path (quit, `exit()`, or the
    /// updater's `relaunch()` → `app.restart()`) abandons orphan shells/agents
    /// to burn resources or AI tokens until the OS reaps them.
    ///
    /// SIGTERM rather than a bare SIGKILL is deliberate: it's catchable, and —
    /// unlike the kernel's SIGHUP-on-master-close we'd otherwise rely on — it
    /// also terminates `nohup`'d processes (they ignore SIGHUP, not SIGTERM).
    /// The negative pid targets the child's whole process group (it's a
    /// session/group leader via `setsid` in `pty_spawn`), so a foreground job
    /// dies with its shell. SIGKILL is the guaranteed backstop for holdouts.
    pub fn drain(&self) {
        // Phase 1: pull every entry out of the map — releasing the DashMap
        // shards before we sleep — and politely ask each to terminate. The
        // child lock is held only long enough to read the pid.
        let ids: Vec<u32> = self.ptys.iter().map(|e| *e.key()).collect();
        let mut draining: Vec<Arc<Pty>> = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some((_, pty)) = self.ptys.remove(&id) {
                if let Ok(child) = pty.child.lock() {
                    // Retained task snapshots outlive their reaped process.
                    // Their numeric pid may already belong to an unrelated
                    // process group, so never signal after the completion
                    // stamp has been published. The natural-exit waiter sets
                    // that stamp before releasing this same child lock.
                    if should_signal_process_on_drain(
                        pty.task_exit.is_some(),
                        pty.task_exited_at_ms.load(Ordering::Acquire),
                    ) {
                        if let Some(pid) = child.process_id() {
                            terminate_process_tree(pid, false);
                        }
                    }
                }
                draining.push(pty);
            }
        }
        if draining.is_empty() {
            return;
        }
        // Phase 2: a single shared grace window (not per-PTY) keeps quit /
        // relaunch latency bounded no matter how many shells are open.
        std::thread::sleep(DRAIN_GRACE);
        // Phase 3: SIGKILL the holdouts and reap them, so the reload path
        // (where the app keeps running) doesn't accumulate zombies. Dropping
        // each `pty` afterwards closes the retained master fd, which HUPs any
        // job-control children that landed in their own process groups.
        for pty in draining {
            let status = if let Ok(mut child) = pty.child.lock() {
                let is_task = pty.task_exit.is_some();
                let task_exited_at_ms = pty.task_exited_at_ms.load(Ordering::Acquire);
                let task_already_exited =
                    !should_signal_process_on_drain(is_task, task_exited_at_ms);
                let force_task_tree = task_process_needs_force_backstop(is_task, task_exited_at_ms);
                if task_already_exited {
                    // `wait` has already run for a retained task. Poll only to
                    // recover its cached status; never route a stale pid into
                    // the force-kill fallback if that poll itself fails.
                    child.try_wait().ok().flatten()
                } else if force_task_tree {
                    // The task shell may have exited while a descendant that
                    // retained the PTY ignored SIGTERM. Force the still-owned
                    // process group before reaping its leader; otherwise the
                    // numeric group id could be reused and the descendant
                    // would keep the reader and PTY alive indefinitely.
                    let pid = child_process_id(&mut child);
                    if let Some(pid) = pid {
                        terminate_process_tree(pid, true);
                    }
                    if let Ok(Some(status)) = child.try_wait() {
                        Some(status)
                    } else {
                        kill_and_reap_child(&mut child, pid)
                    }
                } else if let Ok(Some(status)) = child.try_wait() {
                    Some(status)
                } else {
                    let pid = child_process_id(&mut child);
                    kill_and_reap_child(&mut child, pid) // SIGKILL + reap the zombie
                }
            } else {
                None
            };
            notify_task_process_exited(&pty, status.as_ref());
        }
    }
}

static NEXT_PTY_ID: AtomicU32 = AtomicU32::new(1);
/// State events from replacement PTYs share one monotonic ordering so a late
/// delivery from the old process can never overwrite the newer process state.
static NEXT_ACTIVITY_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static NEXT_SUB_ID: AtomicU32 = AtomicU32::new(1);
static OUTPUT_READS: AtomicU64 = AtomicU64::new(0);
static OUTPUT_BROADCASTS: AtomicU64 = AtomicU64::new(0);
static OUTPUT_BYTES: AtomicU64 = AtomicU64::new(0);
const MAX_PTY_ID_COLLISION_PROBES: usize = 4_096;
/// Includes launching, live, draining, and retained task PTYs. The separate
/// retained-task cap leaves at least half this budget available for live work.
const MAX_ACTIVE_PTYS: usize = 256;
const MAX_PTY_SUBSCRIBERS_PER_PTY: usize = 16;
const MAX_SUB_ID_COLLISION_PROBES: usize = MAX_PTY_SUBSCRIBERS_PER_PTY + 1;
const MAX_ATTACH_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PTY_DIMENSION: u16 = 1_000;

fn validate_pty_dimensions(cols: u16, rows: u16) -> AppResult<()> {
    if cols == 0 || cols > MAX_PTY_DIMENSION || rows == 0 || rows > MAX_PTY_DIMENSION {
        return Err(AppError::BadArg("invalid pty terminal dimensions"));
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct PtyDiagnostics {
    pub output_reads: u64,
    pub output_broadcasts: u64,
    pub output_bytes: u64,
    pub working_agents: usize,
    pub blocked_agents: usize,
    pub idle_agents: usize,
    pub unknown_agents: usize,
}

impl PtyManager {
    pub fn diagnostics(&self) -> PtyDiagnostics {
        let count_state = |state| {
            self.ptys
                .iter()
                .filter(|entry| {
                    entry.value().agent_kind.is_some()
                        && entry.value().activity_state.load(Ordering::Relaxed) == state
                })
                .count()
        };
        PtyDiagnostics {
            output_reads: OUTPUT_READS.load(Ordering::Relaxed),
            output_broadcasts: OUTPUT_BROADCASTS.load(Ordering::Relaxed),
            output_bytes: OUTPUT_BYTES.load(Ordering::Relaxed),
            working_agents: count_state(ACTIVITY_WORKING),
            blocked_agents: count_state(ACTIVITY_BLOCKED),
            idle_agents: count_state(ACTIVITY_IDLE),
            unknown_agents: count_state(ACTIVITY_UNKNOWN),
        }
    }
}

// Scrollback held in the headless vt100 parser. This only has to cover what
// a reattaching xterm replays; anything the user scrolled past before the
// pane was hidden is not worth paying for. A vt100 cell is 32 bytes, so at
// 200 columns 3k rows is roughly 19 MB per PTY — at 10k rows it was 64 MB.
// The parser drops to IDLE_SCROLLBACK when the last subscriber detaches, and
// the sweeper below catches anything silent for IDLE_TRIM.
pub const PARSER_SCROLLBACK: usize = 3_000;
const IDLE_SCROLLBACK: usize = 1_000;
const IDLE_TRIM: Duration = Duration::from_secs(10 * 60);
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const ACTIVITY_POLL_INTERVAL: Duration = Duration::from_millis(250);
const ACTIVITY_SETTLE: Duration = Duration::from_secs(2);
const ACTIVITY_UNKNOWN: u8 = 0;
const ACTIVITY_IDLE: u8 = 1;
const ACTIVITY_WORKING: u8 = 2;
const ACTIVITY_BLOCKED: u8 = 3;
const ACTIVITY_STOPPED: u8 = 4;
#[cfg(unix)]
const OUTPUT_COALESCE: Duration = Duration::from_millis(2);
#[cfg(unix)]
const OUTPUT_BATCH_BYTES: usize = 64 * 1024;
const SLOW_BROADCAST: Duration = Duration::from_millis(8);
/// How many bytes one renderer may owe before the reader stops pulling from
/// the child. The kernel PTY buffer then applies the backpressure for us.
const MAX_UNACKED_BYTES: usize = 512 * 1024;
/// A renderer answers within a frame, so reaching this means it stopped
/// answering at all. Write its debt off rather than stalling the child.
const FLOW_CONTROL_WAIT: Duration = Duration::from_secs(1);
/// One in this many output chunks carries full timing instrumentation.
const OBSERVED_BROADCASTS: u64 = 64;

/// Browser tabs are child webviews of the same app. Every PTY event belongs
/// to the workbench, so address it by label instead of broadcasting.
const MAIN_WEBVIEW: &str = "main";

// Process-start anchor so all `last_activity_ms` values are monotonic
// deltas in ms — immune to wall-clock jumps (NTP, sleep/resume).
fn epoch() -> Instant {
    static E: OnceLock<Instant> = OnceLock::new();
    *E.get_or_init(Instant::now)
}

fn now_ms() -> u64 {
    epoch().elapsed().as_millis() as u64
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::launch::PtyContext;
    use super::PtyCapacity;
    use portable_pty::CommandBuilder;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Barrier};

    pub(super) fn env(command: &CommandBuilder, key: &str) -> Option<String> {
        command
            .get_env(key)
            .map(|value| value.to_string_lossy().into_owned())
    }

    pub(super) fn local_shell_context() -> PtyContext {
        PtyContext {
            session_id: "session-1".into(),
            session_name: "repo".into(),
            session_kind: "project".into(),
            project: Some("/repo".into()),
            window_id: Some("window-1".into()),
            pane_id: Some("pane-1".into()),
            agent_id: None,
            agent_type: None,
            initial_prompt_submitted: false,
            shell_integration: true,
        }
    }

    #[test]
    fn active_pty_capacity_is_hard_under_concurrent_admission() {
        const LIMIT: usize = 7;
        const CONTENDERS: usize = 64;
        let capacity = PtyCapacity::new(LIMIT);
        let barrier = Arc::new(Barrier::new(CONTENDERS + 1));
        let results = std::thread::scope(|scope| {
            let handles = (0..CONTENDERS)
                .map(|_| {
                    let capacity = capacity.clone();
                    let barrier = barrier.clone();
                    scope.spawn(move || {
                        barrier.wait();
                        capacity.try_acquire().ok()
                    })
                })
                .collect::<Vec<_>>();
            barrier.wait();
            handles
                .into_iter()
                .map(|handle| handle.join().expect("capacity contender"))
                .collect::<Vec<_>>()
        });
        let mut permits = results.into_iter().flatten().collect::<Vec<_>>();

        assert_eq!(permits.len(), LIMIT);
        assert_eq!(capacity.active.load(Ordering::Acquire), LIMIT);
        assert!(capacity.try_acquire().is_err());

        permits.pop();
        let replacement = capacity.try_acquire().expect("released slot is reusable");
        assert_eq!(capacity.active.load(Ordering::Acquire), LIMIT);
        drop(replacement);
        drop(permits);
        assert_eq!(capacity.active.load(Ordering::Acquire), 0);
    }
}
