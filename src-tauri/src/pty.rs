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
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::unix::AsyncFd;

use crate::error::{AppError, AppResult};

fn pty_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Pty(e.to_string())
}

/// One running pseudo-terminal: the master + child + headless parser +
/// the set of frontend Channels currently subscribed to live output.
///
/// I/O model: the master fd is set to non-blocking and dup'd twice. The
/// reader-side dup is owned by the reader tokio task; the writer-side
/// dup is wrapped in an `AsyncFd` and guarded by a tokio Mutex so
/// `pty_write` calls serialise without ever blocking a worker thread.
/// The original master fd is retained inside `portable_pty::MasterPty`
/// purely so resize ioctls + child cleanup still work — neither cares
/// about O_NONBLOCK.
struct Pty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    write_async: tokio::sync::Mutex<AsyncFd<File>>,
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
    /// Kill every live PTY. Called from the window-close hook so a
    /// force-quit or last-window-close doesn't leave orphan shell
    /// processes around until the OS reaps them.
    pub fn drain(&self) {
        // collect ids first so we don't hold a DashMap shard while
        // touching child.kill() (which can do FS work on macOS).
        let ids: Vec<u32> = self.ptys.iter().map(|e| *e.key()).collect();
        for id in ids {
            if let Some((_, pty)) = self.ptys.remove(&id) {
                if let Ok(mut child) = pty.child.lock() {
                    let _ = child.kill();
                }
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

/// Drive a non-blocking write to completion against a tokio `AsyncFd`.
/// Loops on EAGAIN via the readiness machinery; returns once every byte
/// has been written or the kernel reports an I/O error.
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
                // Re-seed the parser at the smaller scrollback. The
                // round-trip-via-contents_formatted invariant is exercised
                // by the test below.
                if let Ok(mut parser) = pty.parser.lock() {
                    let (rows, cols) = parser.screen().size();
                    let snapshot = parser.screen().contents_formatted();
                    let mut fresh = vt100::Parser::new(rows, cols, IDLE_SCROLLBACK);
                    fresh.process(&snapshot);
                    *parser = fresh;
                }
                pty.trimmed.store(true, Ordering::Relaxed);
            }
        }
    });
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

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(cwd.unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".into())));

    let child = pair.slave.spawn_command(cmd).map_err(pty_err)?;
    drop(pair.slave);

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
    unsafe {
        let flags = libc::fcntl(master_fd, libc::F_GETFL);
        if flags < 0 {
            return Err(pty_err(std::io::Error::last_os_error()));
        }
        if libc::fcntl(master_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(pty_err(std::io::Error::last_os_error()));
        }
    }

    // Two independent dups of the master fd — one for the async reader,
    // one for the async writer. dup() returns a new fd referring to the
    // same kernel open-file-description, so closing one (e.g. on pty_kill
    // dropping the Pty) does not invalidate the others; portable_pty's
    // own fd inside `pair.master` stays alive until that struct drops.
    let (read_raw, write_raw) = unsafe {
        let r = libc::dup(master_fd);
        let w = libc::dup(master_fd);
        if r < 0 || w < 0 {
            // Roll back whichever succeeded so we don't leak.
            if r >= 0 {
                libc::close(r);
            }
            if w >= 0 {
                libc::close(w);
            }
            return Err(pty_err(std::io::Error::last_os_error()));
        }
        (r, w)
    };
    let read_file = unsafe { File::from_raw_fd(read_raw) };
    let write_file = unsafe { File::from_raw_fd(write_raw) };
    let read_async = AsyncFd::new(read_file).map_err(pty_err)?;
    let write_async = AsyncFd::new(write_file).map_err(pty_err)?;
    let id = NEXT_PTY_ID.fetch_add(1, Ordering::Relaxed);

    let pty = Arc::new(Pty {
        master: Mutex::new(pair.master),
        write_async: tokio::sync::Mutex::new(write_async),
        child: Mutex::new(child),
        parser: Mutex::new(vt100::Parser::new(rows, cols, PARSER_SCROLLBACK)),
        subscribers: Mutex::new(HashMap::new()),
        last_activity_ms: AtomicU64::new(now_ms()),
        trimmed: AtomicBool::new(false),
    });

    // Reader — feeds parser then fans bytes out to subscribers.
    //
    // Runs as a plain tokio task (no dedicated OS thread). `AsyncFd`
    // parks the task until the kernel signals readability via kqueue
    // (macOS) / epoll (linux), at which point `try_io` does a single
    // non-blocking read. WouldBlock just loops back to `readable().await`
    // after clearing the readiness flag, so we never busy-spin.
    //
    // First-output gate for `startup`: the shell's first byte of output
    // is its prompt (rcs run silently then print the PS1). Writing the
    // startup command at that moment means it lands when readline is
    // actually accepting input — replaces the previous frontend
    // setTimeout(350ms) which was a race dressed as a delay.
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
    let pty_reader = pty.clone();
    let app_reader = app.clone();
    let mut startup_pending = startup.filter(|s| !s.is_empty());
    tokio::spawn(async move {
        let mut buf = [0u8; 65536];
        loop {
            let mut guard = match read_async.readable().await {
                Ok(g) => g,
                Err(_) => break,
            };
            let res = guard.try_io(|inner| {
                // impl Read for &File — avoids needing &mut File.
                let mut f = inner.get_ref();
                f.read(&mut buf)
            });
            match res {
                Ok(Ok(0)) => break,            // EOF
                Ok(Err(_)) => break,           // I/O error
                Err(_would_block) => continue, // spurious wake; loop
                Ok(Ok(n)) => {
                    let bytes = &buf[..n];
                    pty_reader
                        .last_activity_ms
                        .store(now_ms(), Ordering::Relaxed);
                    pty_reader.trimmed.store(false, Ordering::Relaxed);
                    let snapshot: Vec<(u32, Channel<Vec<u8>>)> = {
                        let Ok(mut parser) = pty_reader.parser.lock() else {
                            break;
                        };
                        parser.process(bytes);
                        match pty_reader.subscribers.lock() {
                            Ok(subs) => subs.iter().map(|(id, ch)| (*id, ch.clone())).collect(),
                            Err(_) => Vec::new(),
                        }
                    };
                    if !snapshot.is_empty() {
                        let chunk = bytes.to_vec();
                        let mut dead: Vec<u32> = Vec::new();
                        for (sub_id, ch) in &snapshot {
                            if ch.send(chunk.clone()).is_err() {
                                dead.push(*sub_id);
                            }
                        }
                        if !dead.is_empty() {
                            if let Ok(mut subs) = pty_reader.subscribers.lock() {
                                for d in dead {
                                    subs.remove(&d);
                                }
                            }
                        }
                    }
                    // First-output gate: shell has printed its prompt
                    // and reached the read loop; safe to inject startup.
                    if let Some(line) = startup_pending.take() {
                        let writer = pty_reader.write_async.lock().await;
                        let payload = format!("{line}\r");
                        let _ = write_all_async(&writer, payload.as_bytes()).await;
                    }
                }
            }
        }
        // Notify on EOF — empty payload is the frontend's "process exited"
        // signal. Same convention as before.
        if let Ok(subs) = pty_reader.subscribers.lock() {
            for ch in subs.values() {
                let _ = ch.send(Vec::new());
            }
        }
        // If the shell exits by itself, there is no frontend unmount to call
        // `pty_kill`. Remove the manager entry here so the retained master,
        // reader, and writer fds are released instead of accumulating until
        // the app hits macOS' GUI maxfiles limit.
        if let Some(mgr) = app_reader.try_state::<PtyManager>() {
            mgr.ptys.remove(&id);
        }
    });

    manager.ptys.insert(id, pty);
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
    snapshot.extend(screen.state_formatted());
    snapshot
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
    let snapshot = attach_snapshot(parser.screen());
    let mut subs = pty.subscribers.lock().map_err(pty_err)?;
    let sub_id = NEXT_SUB_ID.fetch_add(1, Ordering::Relaxed);
    subs.insert(sub_id, on_event);
    drop(subs);
    drop(parser);
    Ok(AttachResult { sub_id, snapshot })
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
    let writer = pty.write_async.lock().await;
    write_all_async(&writer, data.as_bytes())
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub fn pty_resize(manager: State<'_, PtyManager>, id: u32, cols: u16, rows: u16) -> AppResult<()> {
    let pty = manager
        .ptys
        .get(&id)
        .ok_or(AppError::BadArg("pty not found"))?;
    {
        let master = pty.master.lock().map_err(pty_err)?;
        master.resize(pty_size(cols, rows)).map_err(pty_err)?;
    }
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
    use super::{attach_snapshot, PARSER_SCROLLBACK};

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
    fn scrollback_matches_frontend() {
        // If this number changes, update SCROLLBACK in TerminalPane.tsx
        // so reattach doesn't repaint a truncated history.
        assert_eq!(PARSER_SCROLLBACK, 10_000);
    }
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: u32) -> AppResult<()> {
    if let Some((_, pty)) = manager.ptys.remove(&id) {
        if let Ok(mut child) = pty.child.lock() {
            let _ = child.kill();
        }
        // Notify any remaining subscribers so their xterms render
        // "[process exited]" before the unmount tears them down.
        if let Ok(subs) = pty.subscribers.lock() {
            for ch in subs.values() {
                let _ = ch.send(Vec::new());
            }
        }
    }
    Ok(())
}
