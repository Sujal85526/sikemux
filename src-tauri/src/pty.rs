use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use dashmap::DashMap;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tauri::ipc::Channel;
use tauri::State;

/// One running pseudo-terminal: the master side plus its child process.
struct Pty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

/// All live PTYs, keyed by an id handed back to the frontend. DashMap avoids
/// the single-mutex bottleneck when writing concurrently to multiple PTYs.
#[derive(Default)]
pub struct PtyManager {
    ptys: DashMap<u32, Pty>,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

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
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

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

    manager.ptys.insert(
        id,
        Pty {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
        },
    );
    Ok(id)
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
    let master = pty.master.lock().map_err(|e| e.to_string())?;
    master.resize(pty_size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: u32) -> Result<(), String> {
    if let Some((_, pty)) = manager.ptys.remove(&id) {
        if let Ok(mut child) = pty.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}
