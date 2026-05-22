mod pty;
mod system;

use pty::PtyManager;

pub fn run() {
    tauri::Builder::default()
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            system::home_dir,
            system::recent_dirs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running sikemux");
}
