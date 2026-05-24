mod agents;
mod aws;
mod diff;
mod error;
mod external;
mod files;
mod fs;
mod fs_watch;
mod git;
mod lsp;
mod pty;
mod rundeck;
mod search;
mod settings;
mod ssh;
mod state;
mod system;
mod transparency;

use aws::LogsTailManager;
use pty::PtyManager;
use rundeck::{RundeckLogsManager, RundeckWatchManager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(LogsTailManager::default())
        .manage(RundeckWatchManager::default())
        .manage(RundeckLogsManager::default())
        .setup(|app| {
            // See-through window — same recipe as nackle (NSWindow opaque=NO,
            // CGS background blur via private API). No NSVisualEffectView
            // because its frosted look is heavier than the gaussian CGS blur
            // Terminal.app / iTerm2 / Ghostty use. Default blur=0 == pure
            // transparency; the settings slider goes 0..80.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(handle) = window.ns_window() {
                        unsafe { transparency::apply(handle, 0); }
                    }
                }
            }
            Ok(())
        })
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            system::home_dir,
            system::recent_dirs,
            system::boot_init,
            system::battery_status,
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
            files::list_project_files,
            settings::scan_project_roots,
            settings::expand_path,
            search::project_search,
            ssh::ssh_hosts,
            aws::auth::aws_profiles,
            aws::auth::aws_caller_identity,
            aws::auth::aws_sso_login,
            aws::ecs::aws_ecs_clusters,
            aws::ecs::aws_ecs_services,
            aws::ecs::aws_ecs_tasks,
            aws::ecs::aws_ecs_service_log_config,
            aws::ecs::aws_ecs_task_log_config,
            aws::ec2::aws_ec2_instances,
            aws::lambda::aws_lambda_functions,
            aws::sqs::aws_sqs_queues,
            aws::billing::aws_billing_months,
            aws::s3::aws_s3_buckets,
            aws::logs::aws_logs_tail_start,
            aws::logs::aws_logs_tail_stop,
            rundeck::auth::rnd_status,
            rundeck::auth::rnd_login,
            rundeck::auth::rnd_logout,
            rundeck::projects::rnd_projects,
            rundeck::projects::rnd_jobs,
            rundeck::projects::rnd_branches_matrix,
            rundeck::projects::rnd_resolve_job,
            rundeck::executions::rnd_executions,
            rundeck::executions::rnd_execution,
            rundeck::executions::rnd_execution_state,
            rundeck::executions::rnd_run,
            rundeck::executions::rnd_abort,
            rundeck::watch::rnd_watch_start,
            rundeck::watch::rnd_watch_stop,
            rundeck::logs::rnd_logs_start,
            rundeck::logs::rnd_logs_stop,
            rundeck::plan::rnd_plan,
            external::open_url,
            external::macos_focus_app,
            transparency::set_window_blur,
        ])
        .run(tauri::generate_context!())
        .expect("error while running sikemux");
}
