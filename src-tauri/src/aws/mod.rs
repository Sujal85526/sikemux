// AWS surface — view-only dashboard over the user's SSO-configured profiles.
// Every API call shells out to the `aws` CLI so the heavy SDK crates stay out
// of the binary; the CLI reuses the user's existing SSO token cache and
// ~/.aws/config resolution rules (sso_session refs, source_profile chains,
// region precedence) for free.
//
// Module split:
//   common  — shared helpers (run_aws_cli, aws_json, describe_in_chunks)
//   auth    — profile discovery + identity / SSO login
//   ecs     — clusters, services, tasks, log config
//   ec2     — instance list
//   lambda  — function list
//   sqs     — queue list
//   s3      — bucket list
//   billing — Cost Explorer monthly breakdown
//   logs    — CloudWatch logs tail (long-running, channel-streamed)

// Submodules are `pub` so the Tauri command macro's generated symbols
// (`__cmd__<name>`, `__tauri_command_name_<name>`) remain reachable from
// `generate_handler!`. The handler list in lib.rs references functions by
// their full path (`aws::auth::aws_profiles` etc.) for the same reason.

pub mod auth;
pub mod billing;
mod common;
pub mod ec2;
pub mod ecs;
pub mod lambda;
pub mod logs;
pub mod s3;
pub mod sqs;

pub use logs::LogsTailManager;
