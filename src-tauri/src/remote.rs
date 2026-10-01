//! Remote access and pairing for the Devices settings page. The core keeps
//! the state; these commands only forward to it.

use sikemux_core::protocol::{DeviceAccess, RemoteStatus};
use tauri::State;

use crate::error::AppResult;
use crate::pty::{core_error, PtyManager};

#[tauri::command]
pub async fn remote_status(manager: State<'_, PtyManager>) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client.remote_status().await.map_err(core_error)
}

#[tauri::command]
pub async fn remote_set_enabled(
    manager: State<'_, PtyManager>,
    enabled: bool,
) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client.set_remote_access(enabled).await.map_err(core_error)
}

#[tauri::command]
pub async fn remote_set_device_access(
    manager: State<'_, PtyManager>,
    id: String,
    access: DeviceAccess,
) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client
        .set_device_access(id, access)
        .await
        .map_err(core_error)
}

#[tauri::command]
pub async fn remote_revoke_device(
    manager: State<'_, PtyManager>,
    id: String,
) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client.revoke_device(id).await.map_err(core_error)
}

#[tauri::command]
pub async fn remote_open_pairing(manager: State<'_, PtyManager>) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client.open_pairing().await.map_err(core_error)
}

#[tauri::command]
pub async fn remote_close_pairing(manager: State<'_, PtyManager>) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client.close_pairing().await.map_err(core_error)
}

#[tauri::command]
pub async fn remote_answer_pairing(
    manager: State<'_, PtyManager>,
    id: String,
    allow: bool,
    access: DeviceAccess,
) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client
        .answer_pairing(id, allow, access)
        .await
        .map_err(core_error)
}
