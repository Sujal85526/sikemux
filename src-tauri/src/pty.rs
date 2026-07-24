// PTY layer that scales to 100s of concurrent shells without saturating the
// webview's WebGL context budget.
//
// Architecture:
//
//   * Every PTY in Rust owns a `vt100::Parser` — a headless terminal
//     emulator that maintains the current screen grid + scrollback as
//     bytes arrive. ~80-160 KB per PTY total. No rendering, no DOM, no
//     GPU. Always up to date regardless of whether anyone is looking.
//
//   * The PTY can have ZERO, ONE, or MANY subscribers. A subscriber is a
//     Tauri `Channel<Vec<u8>>` registered by the frontend when a
//     TerminalPane mounts an xterm. When the pane unmounts (user
//     switched away) the subscriber is dropped — the PTY keeps running
//     in the background, parser keeps grid up to date, nothing is lost.
//     On re-focus the pane calls `pty_snapshot` to fetch a fresh ANSI
//     dump of the current grid + scrollback, writes it to a freshly
//     spawned xterm, then subscribes for live output.
//
//   * Result: the only live xterm + WebGL contexts in the app are the
//     ones the user is actually looking at. Hidden PTYs cost ~150 KB of
//     Rust heap and zero rendering work.
//
// Commands surfaced to the frontend:
//
//   pty_spawn       — create a new PTY, returns ptyId
//   pty_attach      — atomic snapshot + subscribe; returns { subId, snapshot }
//   pty_subscribe   — attach a Channel to a PTY, returns subId
//                     (kept for cases where the caller already has the
//                      screen state from a prior attach — e.g. theme reload)
//   pty_unsubscribe — detach a Channel by subId
//   pty_write       — send bytes to the PTY's stdin
//   pty_resize      — change rows/cols (also resizes the parser)
//   pty_kill        — terminate the PTY process

use std::collections::HashMap;
#[cfg(unix)]
use std::fs::File;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;
#[cfg(windows)]
use portable_pty::MasterPty;
use portable_pty::{Child, CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
#[cfg(unix)]
use tokio::io::unix::AsyncFd;

use crate::error::{AppError, AppResult};

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
    parser: Mutex<vt100::Parser>,
    /// Live xterm subscribers. Empty = PTY runs invisibly.
    subscribers: Mutex<HashMap<u32, Channel<Vec<u8>>>>,
    /// Millis-since-process-start of the last chunk processed. The idle
    /// sweeper reads this without contending with the reader because it's
    /// an atomic, not a Mutex.
    last_activity_ms: AtomicU64,
    /// Set true once the sweeper has reseeded the parser at the smaller
    /// scrollback so we don't repeatedly rebuild a parser that's already
    /// at idle size. Cleared on any new activity.
    trimmed: AtomicBool,
}

/// All live PTYs, keyed by an id handed back to the frontend.
#[derive(Default)]
pub struct PtyManager {
    ptys: DashMap<u32, Arc<Pty>>,
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
                    if let Some(pid) = child.process_id() {
                        terminate_process_tree(pid, false);
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
            if let Ok(mut child) = pty.child.lock() {
                if let Ok(Some(_)) = child.try_wait() {
                    continue; // already exited cleanly on SIGTERM
                }
                let pid = child_process_id(&mut child);
                kill_and_reap_child(&mut child, pid); // SIGKILL + reap the zombie
            }
        }
    }
}

static NEXT_PTY_ID: AtomicU32 = AtomicU32::new(1);
static NEXT_SUB_ID: AtomicU32 = AtomicU32::new(1);

// Scrollback held in the headless vt100 parser. Must match (or exceed)
// the frontend's xterm scrollback (`TerminalPane.tsx`'s SCROLLBACK) so a
// reattach can repaint the full visible history. At 80 cols of mostly-
// cleared cells, 10k rows ≈ 1.6 MB per PTY. 100 PTYs → ~160 MB worst-case.
// The sweeper below reclaims this back to IDLE_SCROLLBACK for any PTY
// that's been silent for IDLE_TRIM and has no subscribers attached.
pub const PARSER_SCROLLBACK: usize = 10_000;
const IDLE_SCROLLBACK: usize = 2_000;
const IDLE_TRIM: Duration = Duration::from_secs(10 * 60);
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

// Grace window between the SIGTERM and the SIGKILL backstop in `drain`.
// Long enough for a foreground program (editor, agent, build) to catch
// SIGTERM and flush; short enough that app quit / update-relaunch doesn't
// feel laggy. One shared window, not per-PTY — see `drain`.
const DRAIN_GRACE: Duration = Duration::from_millis(250);

fn child_process_id(child: &mut Box<dyn Child + Send + Sync>) -> Option<u32> {
    child.process_id()
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) {
    if pid == 0 {
        return;
    }
    // Negative pid targets the process group. portable_pty/forkpty makes the
    // shell the session/group leader on Unix; if that assumption ever fails,
    // Child::kill below still targets the direct child as a fallback.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(unix)]
fn terminate_process_tree(pid: u32, force: bool) {
    signal_process_group(pid, if force { libc::SIGKILL } else { libc::SIGTERM });
}

#[cfg(windows)]
fn terminate_process_tree(pid: u32, force: bool) {
    // ConPTY's portable child handle terminates only the direct shell. Use
    // taskkill's tree mode so foreground commands and agent subprocesses do
    // not survive an app close. Child::kill remains the fallback below.
    let mut command = std::process::Command::new("taskkill");
    let pid = pid.to_string();
    command.args(["/PID", &pid, "/T"]);
    if force {
        command.arg("/F");
    }
    let _ = command.status();
}

fn kill_and_reap_child(child: &mut Box<dyn Child + Send + Sync>, pid: Option<u32>) {
    let _ = child.kill();
    if let Some(pid) = pid {
        terminate_process_tree(pid, true);
    }
    let _ = child.wait();
}

fn terminate_and_reap_child(child: &mut Box<dyn Child + Send + Sync>) {
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }
    let pid = child_process_id(child);
    if let Some(pid) = pid {
        terminate_process_tree(pid, false);
    }
    std::thread::sleep(DRAIN_GRACE);
    if let Ok(Some(_)) = child.try_wait() {
        return;
    }
    kill_and_reap_child(child, pid);
}

/// Owns a freshly-spawned child until the fully-initialized `Pty` takes it.
/// Child handles do not kill on drop, so every fallible setup step after spawn
/// must be guarded explicitly.
struct SpawnedChildGuard(Option<Box<dyn Child + Send + Sync>>);

impl SpawnedChildGuard {
    fn new(child: Box<dyn Child + Send + Sync>) -> Self {
        Self(Some(child))
    }

    fn into_inner(mut self) -> Box<dyn Child + Send + Sync> {
        self.0.take().expect("spawned child guard already empty")
    }
}

impl Drop for SpawnedChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let pid = child_process_id(&mut child);
            kill_and_reap_child(&mut child, pid);
        }
    }
}

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

/// Execute startup commands before the interactive shell is launched. Sending
/// text to readline makes it visible in the terminal (and multi-line commands
/// are especially fragile), so startup must be a shell argument, never PTY
/// input. Once it returns, replace the bootstrap shell with the normal local
/// shell so users always land at a usable prompt.
#[cfg(unix)]
fn startup_bootstrap(startup: &str) -> String {
    format!("{startup}\nexec \"$SIKEMUX_SHELL\"")
}

/// Drive a non-blocking write to completion against a tokio `AsyncFd`.
/// Loops on EAGAIN via the readiness machinery; returns once every byte
/// has been written or the kernel reports an I/O error.
#[cfg(unix)]
async fn write_all_async(writer: &AsyncFd<File>, mut data: &[u8]) -> std::io::Result<()> {
    while !data.is_empty() {
        let mut guard = writer.writable().await?;
        let res = guard.try_io(|inner| {
            let mut f = inner.get_ref();
            f.write(data)
        });
        match res {
            Ok(Ok(0)) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "pty write returned 0",
                ));
            }
            Ok(Ok(n)) => {
                data = &data[n..];
            }
            Ok(Err(e)) => return Err(e),
            Err(_would_block) => continue, // readiness cleared; loop
        }
    }
    Ok(())
}

/// One-shot sweeper kickoff. Spawns a single background task on the first
/// `pty_spawn` of the process; subsequent calls are no-ops.
fn ensure_sweeper(app: AppHandle) {
    static SPAWNED: AtomicBool = AtomicBool::new(false);
    if SPAWNED.swap(true, Ordering::Relaxed) {
        return;
    }
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // skip the immediate first tick
        loop {
            ticker.tick().await;
            let Some(mgr) = app.try_state::<PtyManager>() else {
                return;
            };
            let now = now_ms();
            // Snapshot ids first so we never hold a DashMap shard across
            // the parser lock acquisition.
            let candidates: Vec<Arc<Pty>> = mgr.ptys.iter().map(|e| e.value().clone()).collect();
            for pty in candidates {
                if pty.trimmed.load(Ordering::Relaxed) {
                    continue;
                }
                let last = pty.last_activity_ms.load(Ordering::Relaxed);
                if now.saturating_sub(last) < IDLE_TRIM.as_millis() as u64 {
                    continue;
                }
                let has_subs = match pty.subscribers.lock() {
                    Ok(s) => !s.is_empty(),
                    Err(_) => true, // be conservative on poison
                };
                if has_subs {
                    // Don't shrink under an attached xterm — a reattach
                    // would lose scrollback the user might be scrolling
                    // through right now.
                    continue;
                }
                // Re-seed the parser at the smaller scrollback. Alternate
                // screen applications must not be compacted: rebuilding an
                // alternate buffer can destroy the saved normal buffer that
                // 1049l is expected to restore.
                if let Ok(mut parser) = pty.parser.lock() {
                    // Output records activity before taking this lock. Re-read
                    // it here so bytes that raced the optimistic check above
                    // cannot be immediately compacted back to 2,000 rows.
                    let last = pty.last_activity_ms.load(Ordering::Relaxed);
                    if now.saturating_sub(last) < IDLE_TRIM.as_millis() as u64 {
                        continue;
                    }
                    // `pty_attach` takes parser -> subscribers in this same
                    // order. Re-check under the parser lock so an attach that
                    // raced the optimistic check above cannot receive a
                    // snapshot and then have its backing parser compacted.
                    let has_subs = match pty.subscribers.lock() {
                        Ok(s) => !s.is_empty(),
                        Err(_) => true,
                    };
                    if has_subs {
                        continue;
                    }
                    if compact_parser_for_idle(&mut parser) {
                        // Publish the capacity change while still holding the
                        // parser lock. The reader clears this flag and grows
                        // the parser under the same lock before processing its
                        // first new bytes, so no output can land in between.
                        pty.trimmed.store(true, Ordering::Release);
                    }
                }
            }
        }
    });
}

/// Update the headless terminal and fan one output chunk to live subscribers.
/// Both Unix's readiness task and Windows' ConPTY reader thread share this
/// path, preserving the snapshot/subscription ordering invariant.
fn broadcast_output(pty: &Pty, bytes: &[u8]) {
    pty.last_activity_ms.store(now_ms(), Ordering::Relaxed);
    let snapshot: Vec<(u32, Channel<Vec<u8>>)> = {
        let Ok(mut parser) = pty.parser.lock() else {
            return;
        };
        if pty.trimmed.swap(false, Ordering::AcqRel) {
            reseed_parser(&mut parser, PARSER_SCROLLBACK);
        }
        parser.process(bytes);
        match pty.subscribers.lock() {
            Ok(subs) => subs.iter().map(|(id, ch)| (*id, ch.clone())).collect(),
            Err(_) => Vec::new(),
        }
    };
    if snapshot.is_empty() {
        return;
    }
    let chunk = bytes.to_vec();
    let dead: Vec<u32> = snapshot
        .iter()
        .filter_map(|(sub_id, channel)| channel.send(chunk.clone()).err().map(|_| *sub_id))
        .collect();
    if let Ok(mut subscribers) = pty.subscribers.lock() {
        for sub_id in dead {
            subscribers.remove(&sub_id);
        }
    }
}

fn notify_process_exited(pty: &Pty) {
    if let Ok(subscribers) = pty.subscribers.lock() {
        for channel in subscribers.values() {
            let _ = channel.send(Vec::new());
        }
    }
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    startup: Option<String>,
) -> AppResult<u32> {
    ensure_sweeper(app.clone());
    // Has to be `async fn` so the body runs inside Tauri's tokio
    // runtime — both `AsyncFd::new` and `tokio::spawn` below panic
    // ("no reactor running") when called from a sync Tauri command.
    let pair = NativePtySystem::default()
        .openpty(pty_size(cols, rows))
        .map_err(pty_err)?;

    #[cfg(unix)]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    #[cfg(windows)]
    let shell = std::env::var("SIKEMUX_SHELL").unwrap_or_else(|_| "powershell.exe".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    #[cfg(windows)]
    cmd.args(["-NoLogo"]);
    let cwd = cwd.unwrap_or_else(|| crate::system::user_home().to_string_lossy().into_owned());
    let startup = startup.filter(|s| !s.is_empty());
    cmd.cwd(cwd);
    if let Some(startup) = startup.as_deref() {
        #[cfg(unix)]
        {
            cmd.env("SIKEMUX_SHELL", &shell);
            cmd.arg("-c");
            cmd.arg(startup_bootstrap(startup));
        }
        #[cfg(windows)]
        {
            // -NoExit runs the requested startup action and then leaves the
            // user at a normal interactive PowerShell prompt.
            cmd.args(["-NoExit", "-Command", startup]);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(pty_err)?;
    let child = SpawnedChildGuard::new(child);
    drop(pair.slave);

    #[cfg(unix)]
    // Get the master fd and set the underlying open-file-description to
    // O_NONBLOCK. This is shared across every dup of the master (a
    // property of the file description, not the fd), which is exactly
    // what we need: the reader and writer dups below inherit it, and the
    // master fd itself only ever sees ioctl (resize) — unaffected by
    // O_NONBLOCK.
    let master_fd = pair
        .master
        .as_raw_fd()
        .ok_or_else(|| pty_err("master pty has no fd"))?;
    #[cfg(unix)]
    unsafe {
        let flags = libc::fcntl(master_fd, libc::F_GETFL);
        if flags < 0 {
            return Err(pty_err(std::io::Error::last_os_error()));
        }
        // O_NONBLOCK lives on the open-file-description, so the dup below
        // inherits it — one fd, both directions, never blocking.
        if libc::fcntl(master_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(pty_err(std::io::Error::last_os_error()));
        }
    }

    // ONE fd per PTY (was three). dup() the master once, then drop
    // portable_pty's `MasterPty`: that closes the fd it owned, but our dup
    // refers to the SAME kernel open-file-description, so the master end
    // stays open and the child keeps its controlling terminal (no SIGHUP).
    // The single `AsyncFd` services both reads and writes; resize is an
    // ioctl on this fd. At ~50+ live shells this is the difference between
    // ~150 fds and ~50 — the headroom that keeps a heavy session off the
    // process fd limit.
    #[cfg(unix)]
    let dup_fd = unsafe { libc::dup(master_fd) };
    #[cfg(unix)]
    if dup_fd < 0 {
        return Err(pty_err(std::io::Error::last_os_error()));
    }
    #[cfg(unix)]
    drop(pair.master);
    #[cfg(unix)]
    let io_file = unsafe { File::from_raw_fd(dup_fd) };
    #[cfg(windows)]
    let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;
    #[cfg(windows)]
    let writer = pair.master.take_writer().map_err(pty_err)?;
    let id = NEXT_PTY_ID.fetch_add(1, Ordering::Relaxed);

    let pty = Arc::new(Pty {
        #[cfg(unix)]
        io: AsyncFd::new(io_file).map_err(pty_err)?,
        #[cfg(unix)]
        write_lock: tokio::sync::Mutex::new(()),
        #[cfg(windows)]
        master: Mutex::new(pair.master),
        #[cfg(windows)]
        writer: Mutex::new(writer),
        child: Mutex::new(child.into_inner()),
        parser: Mutex::new(vt100::Parser::new(rows, cols, PARSER_SCROLLBACK)),
        subscribers: Mutex::new(HashMap::new()),
        last_activity_ms: AtomicU64::new(now_ms()),
        trimmed: AtomicBool::new(false),
    });

    // Publish before starting the reader. A short-lived command can reach EOF
    // immediately; starting first lets its self-prune remove nothing and then
    // leaves a dead PTY inserted forever.
    manager.ptys.insert(id, pty.clone());

    // Reader — feeds parser then fans bytes out to subscribers.
    //
    // Runs as a plain tokio task (no dedicated OS thread). `AsyncFd`
    // parks the task until the kernel signals readability via kqueue
    // (macOS) / epoll (linux), at which point `try_io` does a single
    // non-blocking read. WouldBlock just loops back to `readable().await`
    // after clearing the readiness flag, so we never busy-spin.
    //
    // Atomicity invariant (vs `pty_attach`): a freshly-attached subscriber
    // must see EXACTLY the bytes NOT present in the snapshot it got back.
    // We achieve that by, under the parser lock:
    //   1. processing the chunk into the parser
    //   2. cloning the subscriber list (Tauri Channels are Arc-internal
    //      and cheap to clone)
    // Both locks are then dropped BEFORE the channel sends — so one slow
    // subscriber can't stall the parser or block another PTY's reattach.
    //
    // Dead subscribers (channel closed because the JS xterm unmounted
    // without explicit unsub) are GC'd on send error so the map stays
    // bounded.
    #[cfg(unix)]
    let pty_reader = pty.clone();
    #[cfg(unix)]
    let app_reader = app.clone();
    #[cfg(unix)]
    tokio::spawn(async move {
        let mut buf = [0u8; 65536];
        loop {
            // Read off the single master fd. The readiness guard is scoped
            // tight and dropped before we touch the parser, so the same
            // `AsyncFd`'s writable() side stays free for a concurrent write.
            let n = {
                let mut guard = match pty_reader.io.readable().await {
                    Ok(g) => g,
                    Err(_) => break,
                };
                match guard.try_io(|inner| {
                    // impl Read for &File — avoids needing &mut File.
                    let mut f = inner.get_ref();
                    f.read(&mut buf)
                }) {
                    Ok(Ok(0)) => break, // EOF
                    Ok(Ok(n)) => n,
                    Ok(Err(_)) => break,           // I/O error
                    Err(_would_block) => continue, // spurious wake; loop
                }
            };
            broadcast_output(&pty_reader, &buf[..n]);
        }
        // Notify on EOF — empty payload is the frontend's "process exited"
        // signal. Same convention as before.
        notify_process_exited(&pty_reader);
        // If the shell exits by itself, there is no frontend unmount to call
        // `pty_kill`. Remove the manager entry here so the retained master
        // fd is released instead of accumulating toward the process fd limit,
        // then reap the child. Without the wait(), long sessions accumulate
        // defunct /bin/zsh children until app quit.
        if let Some(mgr) = app_reader.try_state::<PtyManager>() {
            mgr.ptys.remove(&id);
        }
        let reap_pty = pty_reader.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(mut child) = reap_pty.child.lock() {
                let _ = child.wait();
            }
        });
    });

    #[cfg(windows)]
    {
        let pty_reader = pty.clone();
        let app_reader = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => broadcast_output(&pty_reader, &buf[..n]),
                    Err(_) => break,
                }
            }
            notify_process_exited(&pty_reader);
            if let Some(mgr) = app_reader.try_state::<PtyManager>() {
                mgr.ptys.remove(&id);
            }
            if let Ok(mut child) = pty_reader.child.lock() {
                let _ = child.wait();
            }
        });
    }

    Ok(id)
}

#[tauri::command]
pub fn pty_subscribe(
    manager: State<'_, PtyManager>,
    id: u32,
    on_event: Channel<Vec<u8>>,
) -> AppResult<u32> {
    let pty = manager
        .ptys
        .get(&id)
        .ok_or(AppError::BadArg("pty not found"))?;
    let sub_id = NEXT_SUB_ID.fetch_add(1, Ordering::Relaxed);
    pty.subscribers
        .lock()
        .map_err(pty_err)?
        .insert(sub_id, on_event);
    Ok(sub_id)
}

#[tauri::command]
pub fn pty_unsubscribe(manager: State<'_, PtyManager>, id: u32, sub_id: u32) -> AppResult<()> {
    if let Some(pty) = manager.ptys.get(&id) {
        if let Ok(mut subs) = pty.subscribers.lock() {
            subs.remove(&sub_id);
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachResult {
    pub sub_id: u32,
    pub snapshot: Vec<u8>,
    pub alternate_screen: bool,
}

fn screen_scrollback_len(screen: &vt100::Screen) -> usize {
    let mut s = screen.clone();
    s.set_scrollback(usize::MAX);
    s.scrollback()
}

fn attach_snapshot(screen: &vt100::Screen) -> Vec<u8> {
    let mut snapshot = Vec::new();
    if screen.alternate_screen() {
        // vt100::Screen::state_formatted() restores contents and input
        // modes, but not which screen buffer is active. Re-enter alt
        // screen before replaying alt-buffer contents so xterm's wheel
        // behavior matches the live PTY after a hidden-pane reattach.
        snapshot.extend_from_slice(b"\x1b[?1049h");
    }
    let history_rows = if screen.alternate_screen() {
        0
    } else {
        screen_scrollback_len(screen)
    };
    if history_rows > 0 {
        let (rows, cols) = screen.size();
        let mut scrolled = screen.clone();

        // Seed xterm's scrollback cheaply from vt100's formatted semantic
        // history rows only. `state_formatted` below clears/repaints the live
        // viewport with cursor and input modes; replaying the current viewport
        // here would push a duplicate prompt/input line into scrollback on every
        // reattach, which looks like terminal text repeating after tab switches.
        // Reset between rows because each formatted row is generated from
        // default attrs.
        let page_rows = usize::from(rows).max(1);
        let mut start = 0usize;
        while start < history_rows {
            scrolled.set_scrollback(history_rows - start);
            let take = (history_rows - start).min(page_rows);
            for row in scrolled.rows_formatted(0, cols).take(take) {
                snapshot.extend(row);
                snapshot.extend_from_slice(b"\x1b[0m\r\n");
            }
            start += take;
        }

        // Move the replay cursor far enough that state_formatted's viewport
        // repaint does not overwrite the newest history rows. Without this
        // separator, a fresh parser has a rows-1 hole between the replayed
        // history and the restored live viewport.
        for _ in 1..rows {
            snapshot.extend_from_slice(b"\r\n");
        }
    }
    snapshot.extend(screen.state_formatted());
    snapshot
}

fn reseed_parser(parser: &mut vt100::Parser, scrollback: usize) {
    let (rows, cols) = parser.screen().size();
    let snapshot = attach_snapshot(parser.screen());
    let mut fresh = vt100::Parser::new(rows, cols, scrollback);
    fresh.process(&snapshot);
    *parser = fresh;
}

fn compact_parser_for_idle(parser: &mut vt100::Parser) -> bool {
    if parser.screen().alternate_screen() {
        return false;
    }
    reseed_parser(parser, IDLE_SCROLLBACK);
    true
}

/// Atomic snapshot + subscribe. The parser lock is held while we both
/// capture the screen contents AND insert the subscriber into the
/// fan-out map, so the reader task (which holds parser → broadcast in
/// the same nested order) cannot interleave a byte that ends up both in
/// the snapshot and in the channel — or one that's in neither.
///
/// `snapshot` is the visible screen + scrollback plus input modes as an
/// ANSI byte stream. Writing it to a fresh xterm reproduces the visual
/// state and the mode state that affects input/wheel handling at the
/// moment of the call; bounded in size by `PARSER_SCROLLBACK` rows.
#[tauri::command]
pub fn pty_attach(
    manager: State<'_, PtyManager>,
    id: u32,
    on_event: Channel<Vec<u8>>,
) -> AppResult<AttachResult> {
    let pty = manager
        .ptys
        .get(&id)
        .ok_or(AppError::BadArg("pty not found"))?;
    let parser = pty.parser.lock().map_err(pty_err)?;
    let alternate_screen = parser.screen().alternate_screen();
    let snapshot = attach_snapshot(parser.screen());
    let mut subs = pty.subscribers.lock().map_err(pty_err)?;
    let sub_id = NEXT_SUB_ID.fetch_add(1, Ordering::Relaxed);
    subs.insert(sub_id, on_event);
    drop(subs);
    drop(parser);
    Ok(AttachResult {
        sub_id,
        snapshot,
        alternate_screen,
    })
}

const RESET_MODES: &[u8] = b"\x1b>\x1b[4l\x1b[?1l\x1b[?6l\x1b[?7h\x1b[?9l\x1b[?45l\x1b[?66l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?2004l\x1b[?1049l";

#[tauri::command]
pub fn pty_reset_modes(manager: State<'_, PtyManager>, id: u32) -> AppResult<()> {
    let pty = manager
        .ptys
        .get(&id)
        .ok_or(AppError::BadArg("pty not found"))?;
    let mut parser = pty.parser.lock().map_err(pty_err)?;
    parser.process(RESET_MODES);
    // Queue the exact same bytes to every attached xterm while the parser
    // lock is still held. The reader cannot process and broadcast newer PTY
    // output until this reset is queued, so frontend and backend mode state
    // cannot be reordered around a concurrent child write.
    let mut dead = Vec::new();
    {
        let subscribers = pty.subscribers.lock().map_err(pty_err)?;
        for (sub_id, channel) in subscribers.iter() {
            if channel.send(RESET_MODES.to_vec()).is_err() {
                dead.push(*sub_id);
            }
        }
    }
    drop(parser);
    if !dead.is_empty() {
        let mut subscribers = pty.subscribers.lock().map_err(pty_err)?;
        for sub_id in dead {
            subscribers.remove(&sub_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_write(manager: State<'_, PtyManager>, id: u32, data: String) -> AppResult<()> {
    // Clone the Arc out of DashMap immediately so we don't hold a shard
    // across .await points (which would risk deadlocking the manager).
    let pty = manager
        .ptys
        .get(&id)
        .map(|r| r.clone())
        .ok_or(AppError::BadArg("pty not found"))?;
    #[cfg(unix)]
    // Serialise writers on the shared fd; the reader's readable() side is
    // unaffected and keeps draining concurrently.
    let _guard = pty.write_lock.lock().await;
    #[cfg(unix)]
    write_all_async(&pty.io, data.as_bytes())
        .await
        .map_err(AppError::from)?;
    #[cfg(windows)]
    tauri::async_runtime::spawn_blocking(move || {
        let mut writer = pty.writer.lock().map_err(pty_err)?;
        writer.write_all(data.as_bytes()).map_err(AppError::from)?;
        writer.flush().map_err(AppError::from)
    })
    .await
    .map_err(|e| AppError::Pty(format!("pty_write join: {e}")))??;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(manager: State<'_, PtyManager>, id: u32, cols: u16, rows: u16) -> AppResult<()> {
    let pty = manager
        .ptys
        .get(&id)
        .ok_or(AppError::BadArg("pty not found"))?;
    #[cfg(unix)]
    {
        // Resize via TIOCSWINSZ straight on the master fd (the kernel also
        // raises SIGWINCH on the foreground process group).
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        let rc = unsafe {
            libc::ioctl(
                pty.io.get_ref().as_raw_fd(),
                libc::TIOCSWINSZ,
                &ws as *const _,
            )
        };
        if rc != 0 {
            return Err(pty_err(std::io::Error::last_os_error()));
        }
    }
    #[cfg(windows)]
    pty.master
        .lock()
        .map_err(pty_err)?
        .resize(pty_size(cols, rows))
        .map_err(pty_err)?;
    // Resize the parser too so the grid the snapshot returns matches the
    // xterm's geometry — otherwise re-attach lands on a mis-sized canvas.
    // `set_size` lives on the Screen, not the Parser itself.
    if let Ok(mut parser) = pty.parser.lock() {
        parser.screen_mut().set_size(rows, cols);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::startup_bootstrap;
    use super::{
        attach_snapshot, compact_parser_for_idle, reseed_parser, AttachResult, IDLE_SCROLLBACK,
        PARSER_SCROLLBACK, RESET_MODES,
    };

    #[test]
    fn snapshot_round_trips_visible_state() {
        // Smoke-check the contract pty_attach relies on: a parser whose
        // bytes were processed re-emits an ANSI stream that reproduces the
        // visible state when written back into a fresh parser. The full
        // attach/snapshot path can't be exercised without a real PTY, but
        // the parser invariant is the load-bearing piece.
        let mut a = vt100::Parser::new(24, 80, PARSER_SCROLLBACK);
        a.process(b"hello world\r\nsecond line\r\n");
        let dump = a.screen().contents_formatted();

        let mut b = vt100::Parser::new(24, 80, PARSER_SCROLLBACK);
        b.process(&dump);
        assert_eq!(
            a.screen().contents(),
            b.screen().contents(),
            "snapshot did not round-trip cleanly",
        );
    }

    #[test]
    fn attach_snapshot_restores_input_modes() {
        let mut a = vt100::Parser::new(24, 80, PARSER_SCROLLBACK);
        a.process(b"\x1b[?2004h\x1b[?1000h\x1b[?1006h");
        let dump = attach_snapshot(a.screen());

        let mut b = vt100::Parser::new(24, 80, PARSER_SCROLLBACK);
        b.process(&dump);

        assert!(b.screen().bracketed_paste());
        assert_eq!(
            b.screen().mouse_protocol_mode(),
            vt100::MouseProtocolMode::PressRelease,
        );
        assert_eq!(
            b.screen().mouse_protocol_encoding(),
            vt100::MouseProtocolEncoding::Sgr,
        );
    }

    #[test]
    fn attach_snapshot_restores_scrollback() {
        let mut a = vt100::Parser::new(5, 20, PARSER_SCROLLBACK);
        for i in 0..20 {
            a.process(format!("line {i:02}\r\n").as_bytes());
        }
        let dump = attach_snapshot(a.screen());

        let mut b = vt100::Parser::new(5, 20, PARSER_SCROLLBACK);
        b.process(&dump);

        assert_eq!(b.screen().contents(), a.screen().contents());

        let screen = b.screen_mut();
        screen.set_scrollback(usize::MAX);
        assert!(
            screen.scrollback() >= 10,
            "reattach snapshot should seed xterm/vt100 scrollback; got {} rows",
            screen.scrollback()
        );
        assert!(
            screen.contents().contains("line 00"),
            "oldest retained output should be reachable after scrolling"
        );
    }

    #[test]
    fn attach_snapshot_restores_scrollback_attrs() {
        let mut a = vt100::Parser::new(5, 20, PARSER_SCROLLBACK);
        for i in 0..20 {
            let color = 31 + (i % 6);
            a.process(format!("\x1b[{color}mline {i:02}\x1b[0m\r\n").as_bytes());
        }
        let dump = attach_snapshot(a.screen());

        let mut b = vt100::Parser::new(5, 20, PARSER_SCROLLBACK);
        b.process(&dump);

        assert_eq!(b.screen().contents(), a.screen().contents());

        let screen = b.screen_mut();
        screen.set_scrollback(usize::MAX);
        assert!(
            screen.contents().contains("line 00"),
            "oldest retained output should be reachable after scrolling"
        );
        assert_eq!(
            screen
                .cell(0, 0)
                .expect("top-left scrollback cell")
                .fgcolor(),
            vt100::Color::Idx(1),
            "reattach snapshot should preserve attrs for scrolled-out rows"
        );
    }

    #[test]
    fn attach_snapshot_restores_alternate_screen() {
        let mut a = vt100::Parser::new(24, 80, PARSER_SCROLLBACK);
        a.process(b"normal\r\n\x1b[?1049halt");
        let dump = attach_snapshot(a.screen());

        let mut b = vt100::Parser::new(24, 80, PARSER_SCROLLBACK);
        b.process(&dump);

        assert!(b.screen().alternate_screen());
        assert_eq!(b.screen().contents(), a.screen().contents());
    }

    #[test]
    fn attach_snapshot_has_exact_history_continuity_without_blank_hole() {
        let mut source = vt100::Parser::new(5, 20, PARSER_SCROLLBACK);
        for i in 0..30 {
            source.process(format!("line {i:02}\r\n").as_bytes());
        }

        let mut restored = vt100::Parser::new(5, 20, PARSER_SCROLLBACK);
        restored.process(&attach_snapshot(source.screen()));

        let source_screen = source.screen_mut();
        source_screen.set_scrollback(5);
        let expected = source_screen.contents();
        source_screen.set_scrollback(0);
        let expected_viewport = source_screen.contents();

        let screen = restored.screen_mut();
        screen.set_scrollback(5);
        let joined = screen.contents();
        assert_eq!(joined, expected, "history-to-viewport boundary has a hole");
        assert!(!joined.lines().any(|line| line.trim().is_empty()));
        screen.set_scrollback(0);
        assert_eq!(screen.contents(), expected_viewport);
    }

    #[test]
    fn idle_compaction_retains_tail_and_modes() {
        let mut parser = vt100::Parser::new(5, 20, PARSER_SCROLLBACK);
        for i in 0..2_100 {
            parser.process(format!("line {i:04}\r\n").as_bytes());
        }
        parser.process(b"\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006h");

        assert!(compact_parser_for_idle(&mut parser));
        assert!(parser.screen().application_cursor());
        assert!(parser.screen().bracketed_paste());
        assert_eq!(
            parser.screen().mouse_protocol_mode(),
            vt100::MouseProtocolMode::ButtonMotion
        );
        assert_eq!(
            parser.screen().mouse_protocol_encoding(),
            vt100::MouseProtocolEncoding::Sgr
        );
        let screen = parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        assert!(screen.scrollback() <= IDLE_SCROLLBACK);
        assert!(screen.contents().contains("line 0100"));
    }

    #[test]
    fn idle_compaction_skips_alternate_screen() {
        let mut parser = vt100::Parser::new(5, 20, PARSER_SCROLLBACK);
        parser.process(b"normal history\r\n\x1b[?1049halt screen");
        let before = attach_snapshot(parser.screen());

        assert!(!compact_parser_for_idle(&mut parser));
        assert_eq!(attach_snapshot(parser.screen()), before);
        assert!(parser.screen().alternate_screen());
    }

    #[test]
    fn reseed_restores_full_future_scrollback_capacity() {
        let mut parser = vt100::Parser::new(5, 20, IDLE_SCROLLBACK);
        for i in 0..1_000 {
            parser.process(format!("old {i:04}\r\n").as_bytes());
        }
        reseed_parser(&mut parser, PARSER_SCROLLBACK);
        for i in 0..3_000 {
            parser.process(format!("new {i:04}\r\n").as_bytes());
        }

        let screen = parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        assert!(screen.scrollback() > IDLE_SCROLLBACK);
        assert!(screen.contents().contains("old 0000"));
    }

    #[test]
    fn attach_result_serializes_alternate_screen_camel_case() {
        let value = serde_json::to_value(AttachResult {
            sub_id: 7,
            snapshot: Vec::new(),
            alternate_screen: true,
        })
        .expect("serialize attach result");
        assert_eq!(value["alternateScreen"], true);
        assert!(value.get("alternate_screen").is_none());
    }

    #[test]
    fn reset_modes_disables_interaction_modes_without_losing_normal_history() {
        let mut parser = vt100::Parser::new(5, 20, PARSER_SCROLLBACK);
        for i in 0..20 {
            parser.process(format!("line {i:02}\r\n").as_bytes());
        }
        parser.process(
            b"\x1b=\x1b[?1h\x1b[?9h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1005h\x1b[?1006h\x1b[?2004h\x1b[?1049halt",
        );
        parser.process(RESET_MODES);

        assert!(!parser.screen().alternate_screen());
        assert!(!parser.screen().application_keypad());
        assert!(!parser.screen().application_cursor());
        assert!(!parser.screen().bracketed_paste());
        assert_eq!(
            parser.screen().mouse_protocol_mode(),
            vt100::MouseProtocolMode::None
        );
        assert_eq!(
            parser.screen().mouse_protocol_encoding(),
            vt100::MouseProtocolEncoding::Default
        );
        let screen = parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        assert!(screen.contents().contains("line 00"));
    }

    #[test]
    fn scrollback_matches_frontend() {
        // If this number changes, update SCROLLBACK in TerminalPane.tsx
        // so reattach doesn't repaint a truncated history.
        assert_eq!(PARSER_SCROLLBACK, 10_000);
    }

    #[cfg(unix)]
    #[test]
    fn startup_runs_before_the_interactive_shell_without_pty_input() {
        let bootstrap = startup_bootstrap("ssh prod-db");
        assert_eq!(bootstrap, "ssh prod-db\nexec \"$SIKEMUX_SHELL\"");
        assert!(!bootstrap.contains('\r'));
    }

    // The load-bearing invariant of the single-fd PTY design: after we dup
    // the master and drop portable_pty's `MasterPty`, the dup must keep the
    // master open-file-description (and therefore the child's controlling
    // terminal) alive. The child sleeps, THEN prints — so if dropping the
    // MasterPty had hung up the terminal, the child would take SIGHUP during
    // the sleep and the read below would hit EOF before the marker arrives.
    #[cfg(unix)]
    #[test]
    fn lone_master_dup_keeps_child_alive_after_masterpty_drop() {
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
        use std::io::Read;
        use std::os::fd::FromRawFd;

        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("sleep 0.2; printf MARKER");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let master_fd = pair.master.as_raw_fd().expect("master fd");
        let dup_fd = unsafe { libc::dup(master_fd) };
        assert!(dup_fd >= 0, "dup failed");
        // The whole point: drop the MasterPty (closes the fd it owned) while
        // our dup still references the same OFD.
        drop(pair.master);

        let mut file = unsafe { std::fs::File::from_raw_fd(dup_fd) };
        let mut got = String::new();
        let mut buf = [0u8; 256];
        loop {
            match file.read(&mut buf) {
                Ok(0) => break, // EOF — child gone / pty closed
                Ok(n) => {
                    got.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if got.contains("MARKER") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = child.wait();
        assert!(
            got.contains("MARKER"),
            "child did not survive MasterPty drop / output never reached the lone dup; got {got:?}"
        );
    }
}

#[tauri::command]
pub async fn pty_kill(manager: State<'_, PtyManager>, id: u32) -> AppResult<()> {
    if let Some((_, pty)) = manager.ptys.remove(&id) {
        // Notify any remaining subscribers so their xterms render
        // "[process exited]" before the unmount tears them down.
        if let Ok(subs) = pty.subscribers.lock() {
            for ch in subs.values() {
                let _ = ch.send(Vec::new());
            }
        }
        // Killing without wait() leaves zombies. Do the potentially-slow
        // SIGTERM grace + SIGKILL backstop on the blocking pool, not on the
        // async runtime worker.
        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(mut child) = pty.child.lock() {
                terminate_and_reap_child(&mut child);
            }
        })
        .await
        .map_err(|e| AppError::Pty(format!("pty_kill join: {e}")))?;
    }
    Ok(())
}
