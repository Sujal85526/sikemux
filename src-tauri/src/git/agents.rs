//! Which agent wrote what in a checkout, as the core works it out from its
//! record of agents' edits.

use serde_json::{json, Value};
use tauri::State;

use crate::agent_names::call;
use crate::error::AppResult;
use crate::pty::PtyManager;

/// Who wrote each uncommitted line in `repo`, or each staged one when `staged`.
#[tauri::command]
pub async fn git_change_owners(
    manager: State<'_, PtyManager>,
    repo: String,
    staged: bool,
) -> AppResult<Value> {
    let client = manager.client().await?;
    call(
        &client,
        "changeOwners".to_owned(),
        json!({ "dir": repo, "staged": staged }),
    )
    .await
}

/// The trailer lines naming the agents whose work is staged in `repo`; none
/// when the core cannot be asked.
pub(super) async fn commit_trailers(manager: &PtyManager, repo: &str) -> Vec<String> {
    let Ok(client) = manager.client().await else {
        return Vec::new();
    };
    call(&client, "commitTrailers".to_owned(), json!({ "dir": repo }))
        .await
        .ok()
        .and_then(|lines| serde_json::from_value(lines).ok())
        .unwrap_or_default()
}
