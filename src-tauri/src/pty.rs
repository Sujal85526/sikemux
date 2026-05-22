use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tauri::ipc::Channel;
use tauri::State;

/// One running pseudo-terminal: the master side plus its child process.
struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// All live PTYs, keyed by an id handed back to the frontend.
#[derive(Default)]
pub struct PtyManager {
    ptys: Mutex<HashMap<u32, Pty>>,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

/// Spawn a shell in a new PTY. Output streams back over `on_event`; an empty
/// chunk marks process exit. Returns the pty id.
#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_event: Channel<Vec<u8>>,
) -> Result<u32, String> {
    let pair = NativePtySystem::default()
        .openpty(pty_size(cols, rows))
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(cwd.unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".into())));

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Drop the slave: the child holds its own handle, and keeping ours open
    // would stop EOF from ever arriving on the master after the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    // Reader thread. The 64 KiB buffer already coalesces output bursts into
    // large chunks; a frame-cadence flush is a planned refinement only.
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if on_event.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = on_event.send(Vec::new());
    });

    manager
        .ptys
        .lock()
        .unwrap()
        .insert(id, Pty { master: pair.master, writer, child });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
    let mut ptys = manager.ptys.lock().unwrap();
    let pty = ptys.get_mut(&id).ok_or("pty not found")?;
    pty.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    pty.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let ptys = manager.ptys.lock().unwrap();
    let pty = ptys.get(&id).ok_or("pty not found")?;
    pty.master.resize(pty_size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: u32) -> Result<(), String> {
    if let Some(mut pty) = manager.ptys.lock().unwrap().remove(&id) {
        let _ = pty.child.kill();
    }
    Ok(())
}
