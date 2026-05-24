// Rundeck integration — full-fledged in-app deploy center.
//
// Unlike the AWS surface (which shells out to the `aws` CLI), Rundeck talks
// plain bearer-token REST so we hit the API directly via reqwest. Reasons:
//
//   1. The matrix dashboard fans out N × M (services × envs) per refresh —
//      one async HTTP client with keep-alive beats forking subprocess-per-cell.
//   2. The live execution view streams /state + /output diffs every ~1.5s
//      to a Tauri Channel. Subprocess polling can't give us that shape.
//   3. The bash CLI's auth flow is the only really tricky bit; we mirror it
//      faithfully and stay byte-compatible with `~/.rd-config` so `rnd login`
//      from a terminal and our in-app login coexist.
//
// Module split:
//   config      — read/write ~/.rd-config (CLI-compatible key=value)
//   client      — singleton reqwest::Client + auto-refresh on 401/403
//   auth        — j_security_check → POST /tokens/{user}; verify via /system/info
//   projects    — projects, jobs, branches_matrix (parallel)
//   executions  — last, history, run, abort
//   watch       — long-running execution state watcher → Channel
//   logs        — log tail with offset cursor → Channel
//   plan        — read-only git inspection (dirty / ahead-behind / relation)

pub mod auth;
mod client;
pub mod config;
pub mod executions;
pub mod logs;
pub mod plan;
pub mod projects;
pub mod watch;

pub use logs::LogsManager as RundeckLogsManager;
pub use watch::WatchManager as RundeckWatchManager;
