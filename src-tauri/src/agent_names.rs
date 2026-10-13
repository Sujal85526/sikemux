//! Agents' names. The core gives them and keeps them; these commands pass
//! the app's asks on to it.

use serde_json::Value;
use sikemux_core::client::Reply;
use sikemux_core::protocol::{Request, Response};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::pty::{core_error, PtyManager};

/// The core's name calls, the only ones the page may make through this.
const METHODS: [&str; 2] = ["nameAgent", "renameAgent"];

#[tauri::command]
pub async fn agent_name_call(
    manager: State<'_, PtyManager>,
    method: String,
    params: Value,
) -> AppResult<Value> {
    if !METHODS.contains(&method.as_str()) {
        return Err(AppError::Other(format!("{method} is not a name call")));
    }
    let client = manager.client().await?;
    let reply = client
        .submit(Request::Call { method, params }, |reply| reply)
        .map_err(core_error)?
        .await
        .map_err(core_error)?
        .map_err(core_error)?;
    match reply {
        Reply::Response(Response::Called { result }) => Ok(result),
        _ => Err(AppError::Other(
            "the core answered a name call with something else".into(),
        )),
    }
}
