mod agents;
mod diff;
mod fs;
mod fs_watch;
mod git;
mod lsp;
mod pty;
mod state;
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
            system::boot_init,
            state::state_load,
            state::state_save,
            agents::agent_sessions,
            fs::read_dir,
            fs::read_file,
            fs::write_file,
            fs_watch::repo_watch_start,
            fs_watch::repo_watch_stop,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_branches,
            git::git_checkout,
            git::git_log,
            git::git_overview,
            git::git_show,
            git::git_file_at,
            git::git_commit_files,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_ai_commit,
            git::pr_open,
            lsp::lsp_start,
            lsp::lsp_open,
            lsp::lsp_change,
            lsp::lsp_locations,
            diff::diff_hunks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running sikemux");
}
