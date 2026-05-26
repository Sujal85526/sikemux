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
//   pty_subscribe   — attach a Channel to a PTY, returns subId
//   pty_unsubscribe — detach a Channel by subId
//   pty_snapshot    — get the current grid + scrollback as ANSI bytes
//                     (write directly to xterm to repaint state)
//   pty_write       — send bytes to the PTY's stdin
//   pty_resize      — change rows/cols (also resizes the parser)
//   pty_kill        — terminate the PTY process

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tauri::ipc::Channel;
use tauri::State;

/// One running pseudo-terminal: the master + child + headless parser +
/// the set of frontend Channels currently subscribed to live output.
struct Pty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Tracks the current screen grid + scrollback. Always up to date,
    /// even when no one's subscribed — that's the whole point.
    parser: Mutex<vt100::Parser>,
    /// Live xterm subscribers. Empty = PTY runs invisibly.
    subscribers: Mutex<HashMap<u32, Channel<Vec<u8>>>>,
}

/// All live PTYs, keyed by an id handed back to the frontend.
#[derive(Default)]
pub struct PtyManager {
    ptys: DashMap<u32, Arc<Pty>>,
}

static NEXT_PTY_ID: AtomicU32 = AtomicU32::new(1);
static NEXT_SUB_ID: AtomicU32 = AtomicU32::new(1);

// 1000 rows of scrollback per PTY — matches xterm's default. At 80 cols
// of mostly-cleared cells that's ~160 KB. 100 PTYs → ~16 MB. Tolerable.
const PARSER_SCROLLBACK: usize = 1000;

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<u32, String> {
    let pair = NativePtySystem::default()
        .openpty(pty_size(cols, rows))
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(cwd.unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".into())));

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT_PTY_ID.fetch_add(1, Ordering::Relaxed);

    let pty = Arc::new(Pty {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        parser: Mutex::new(vt100::Parser::new(rows, cols, PARSER_SCROLLBACK)),
        subscribers: Mutex::new(HashMap::new()),
    });

    // Reader thread — feeds parser then fans bytes out to subscribers.
    // Parser is held LOCKED across the broadcast so `pty_attach` (which
    // grabs parser → snapshot → insert subscriber while holding parser)
    // sees atomic "either before-this-chunk or after-this-chunk" state.
    // Without this, a chunk could be both included in a snapshot AND
    // delivered to the freshly-attached subscriber — visible as duplicate
    // bytes/escape sequences on the first frame after a pane re-show.
    //
    // Dead subscribers (channel closed because the JS xterm unmounted
    // without explicit unsub) are GC'd on send error so the map stays
    // bounded.
    let pty_reader = pty.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let bytes = &buf[..n];
                    if let Ok(mut parser) = pty_reader.parser.lock() {
                        parser.process(bytes);
                        if let Ok(mut subs) = pty_reader.subscribers.lock() {
                            if !subs.is_empty() {
                                let chunk = bytes.to_vec();
                                let mut dead: Vec<u32> = Vec::new();
                                for (sub_id, ch) in subs.iter() {
                                    if ch.send(chunk.clone()).is_err() {
                                        dead.push(*sub_id);
                                    }
                                }
                                for d in dead { subs.remove(&d); }
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        // Notify on EOF — empty payload is the frontend's "process exited"
        // signal. Same convention as before.
        if let Ok(subs) = pty_reader.subscribers.lock() {
            for ch in subs.values() {
                let _ = ch.send(Vec::new());
            }
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
) -> Result<u32, String> {
    let pty = manager.ptys.get(&id).ok_or("pty not found")?;
    let sub_id = NEXT_SUB_ID.fetch_add(1, Ordering::Relaxed);
    pty.subscribers
        .lock()
        .map_err(|e| e.to_string())?
        .insert(sub_id, on_event);
    Ok(sub_id)
}

#[tauri::command]
pub fn pty_unsubscribe(
    manager: State<'_, PtyManager>,
    id: u32,
    sub_id: u32,
) -> Result<(), String> {
    if let Some(pty) = manager.ptys.get(&id) {
        if let Ok(mut subs) = pty.subscribers.lock() {
            subs.remove(&sub_id);
        }
    }
    Ok(())
}

/// Snapshot of the current screen + scrollback as a single ANSI byte
/// stream. Writing this to a fresh xterm reproduces the visual state of
/// the PTY at the moment of the call — colors, cursor position,
/// scrollback rows. Replaces the "buffer-and-replay raw bytes" approach
/// (which forced xterm to re-parse N seconds of history per switch).
#[tauri::command]
pub fn pty_snapshot(
    manager: State<'_, PtyManager>,
    id: u32,
) -> Result<Vec<u8>, String> {
    let pty = manager.ptys.get(&id).ok_or("pty not found")?;
    let parser = pty.parser.lock().map_err(|e| e.to_string())?;
    let screen = parser.screen();
    // contents_formatted includes the visible screen + scrollback as
    // ANSI escapes (cursor, attrs, colors all baked in). One write to
    // xterm reproduces the state; bounded in size by the parser
    // scrollback config (~PARSER_SCROLLBACK rows worth).
    Ok(screen.contents_formatted())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachResult {
    pub sub_id: u32,
    pub snapshot: Vec<u8>,
}

/// Atomic snapshot + subscribe. The parser lock is held while we both
/// capture the screen contents AND insert the subscriber into the
/// fan-out map, so the reader thread (which holds parser → broadcast in
/// the same nested order) cannot interleave a byte that ends up both in
/// the snapshot and in the channel — or one that's in neither.
///
/// Preferred over calling `pty_snapshot` + `pty_subscribe` from JS
/// because the gap between those two IPC calls is wide enough for
/// real-world TUI agents to redraw a frame.
#[tauri::command]
pub fn pty_attach(
    manager: State<'_, PtyManager>,
    id: u32,
    on_event: Channel<Vec<u8>>,
) -> Result<AttachResult, String> {
    let pty = manager.ptys.get(&id).ok_or("pty not found")?;
    let parser = pty.parser.lock().map_err(|e| e.to_string())?;
    let snapshot = parser.screen().contents_formatted();
    let mut subs = pty.subscribers.lock().map_err(|e| e.to_string())?;
    let sub_id = NEXT_SUB_ID.fetch_add(1, Ordering::Relaxed);
    subs.insert(sub_id, on_event);
    drop(subs);
    drop(parser);
    Ok(AttachResult { sub_id, snapshot })
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    let pty = manager.ptys.get(&id).ok_or("pty not found")?;
    let mut writer = pty.writer.lock().map_err(|e| e.to_string())?;
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty = manager.ptys.get(&id).ok_or("pty not found")?;
    {
        let master = pty.master.lock().map_err(|e| e.to_string())?;
        master.resize(pty_size(cols, rows)).map_err(|e| e.to_string())?;
    }
    // Resize the parser too so the grid the snapshot returns matches the
    // xterm's geometry — otherwise re-attach lands on a mis-sized canvas.
    // `set_size` lives on the Screen, not the Parser itself.
    if let Ok(mut parser) = pty.parser.lock() {
        parser.screen_mut().set_size(rows, cols);
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: u32) -> Result<(), String> {
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
