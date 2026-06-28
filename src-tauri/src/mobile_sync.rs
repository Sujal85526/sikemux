use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State as AxumState};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use futures::{SinkExt, StreamExt};
use qrcode::render::svg;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::error::{AppError, AppResult};
use crate::pty::{pty_resize, pty_spawn, MobilePtyAttach, PtyManager};
use crate::state;

const DEFAULT_BIND: &str = "127.0.0.1:48731";
const ENV_ENABLE: &str = "SIKEMUX_MOBILE_SYNC";
const ENV_BIND: &str = "SIKEMUX_MOBILE_BIND";
const TOKEN_FILE: &str = "mobile.token";

#[derive(Default)]
struct MobileSyncInner {
    running: Option<RunningServer>,
}

struct RunningServer {
    bind: String,
    addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
struct HttpState {
    token: String,
    shared: Arc<MobileSyncShared>,
    app: AppHandle,
}

struct MobileSyncShared {
    latest_state: Mutex<Option<String>>,
    state_tx: broadcast::Sender<String>,
}

impl Default for MobileSyncShared {
    fn default() -> Self {
        let (state_tx, _) = broadcast::channel(32);
        Self {
            latest_state: Mutex::new(None),
            state_tx,
        }
    }
}

#[derive(Default)]
pub struct MobileSyncManager {
    inner: Mutex<MobileSyncInner>,
    shared: Arc<MobileSyncShared>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MobileSyncStatus {
    running: bool,
    bind: Option<String>,
    addr: Option<String>,
    base_url: Option<String>,
    websocket_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSyncPairingInfo {
    token: String,
    running: bool,
    base_url: Option<String>,
    websocket_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSyncPairingQr {
    payload: String,
    svg: String,
}

#[derive(Deserialize)]
struct AuthQuery {
    token: Option<String>,
}

impl MobileSyncManager {
    pub async fn start(&self, bind: String, app_handle: AppHandle) -> AppResult<MobileSyncStatus> {
        if let Some(status) = self.status_running()? {
            return Ok(status);
        }

        let token = ensure_pairing_token()?;
        let listener = TcpListener::bind(&bind)
            .await
            .map_err(|e| AppError::Other(format!("mobile sync bind {bind}: {e}")))?;
        let addr = listener.local_addr().map_err(AppError::from)?;
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let http_state = HttpState {
            token,
            shared: self.shared.clone(),
            app: app_handle,
        };
        let app = Router::new()
            .route("/health", get(health_route))
            .route("/state", get(state_route))
            .route("/ws", get(ws_route))
            .with_state(http_state);

        tauri::async_runtime::spawn(async move {
            let server =
                axum::serve(listener, app.into_make_service()).with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                });
            if let Err(err) = server.await {
                eprintln!("sikemux mobile sync server stopped with error: {err}");
            }
        });

        let mut inner = self
            .inner
            .lock()
            .map_err(|e| AppError::Other(format!("mobile sync lock: {e}")))?;
        inner.running = Some(RunningServer {
            bind,
            addr,
            shutdown: Some(shutdown_tx),
        });
        Ok(status_from_running(inner.running.as_ref()))
    }

    pub fn stop(&self) -> AppResult<MobileSyncStatus> {
        let running = self
            .inner
            .lock()
            .map_err(|e| AppError::Other(format!("mobile sync lock: {e}")))?
            .running
            .take();
        if let Some(mut running) = running {
            if let Some(shutdown) = running.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
        self.status()
    }

    pub fn status(&self) -> AppResult<MobileSyncStatus> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| AppError::Other(format!("mobile sync lock: {e}")))?;
        Ok(status_from_running(inner.running.as_ref()))
    }

    fn status_running(&self) -> AppResult<Option<MobileSyncStatus>> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| AppError::Other(format!("mobile sync lock: {e}")))?;
        Ok(inner
            .running
            .as_ref()
            .map(|running| status_from_running(Some(running))))
    }

    pub fn pairing_info(&self) -> AppResult<MobileSyncPairingInfo> {
        let token = ensure_pairing_token()?;
        let status = self.status()?;
        Ok(MobileSyncPairingInfo {
            token,
            running: status.running,
            base_url: status.base_url,
            websocket_url: status.websocket_url,
        })
    }

    pub fn pairing_qr(&self, public_url: Option<String>) -> AppResult<MobileSyncPairingQr> {
        let token = ensure_pairing_token()?;
        let status = self.status()?;
        let url = normalise_pairing_url(public_url, status.base_url);
        let ws_url = url_to_ws(&url);
        let payload = serde_json::to_string(&json!({
            "type": "sikemux.mobile.pair",
            "version": 1,
            "url": url,
            "wsUrl": ws_url,
            "token": token,
        }))?;
        let code = QrCode::new(payload.as_bytes()).map_err(|e| AppError::Other(format!("qr: {e}")))?;
        let svg = code
            .render::<svg::Color<'_>>()
            .min_dimensions(260, 260)
            .quiet_zone(true)
            .dark_color(svg::Color("#e5eef9"))
            .light_color(svg::Color("transparent"))
            .build();
        Ok(MobileSyncPairingQr { payload, svg })
    }

    pub fn update_state(&self, data: String) -> AppResult<()> {
        // Validate before publishing so the mobile endpoint always returns JSON.
        let _: Value = serde_json::from_str(&data)?;
        if let Ok(mut latest) = self.shared.latest_state.lock() {
            *latest = Some(data.clone());
        }
        let _ = self.shared.state_tx.send(data);
        Ok(())
    }
}

fn status_from_running(running: Option<&RunningServer>) -> MobileSyncStatus {
    if let Some(running) = running {
        let base = format!("http://{}", running.addr);
        MobileSyncStatus {
            running: true,
            bind: Some(running.bind.clone()),
            addr: Some(running.addr.to_string()),
            base_url: Some(base.clone()),
            websocket_url: Some(format!("{}/ws", base.replace("http://", "ws://"))),
        }
    } else {
        MobileSyncStatus {
            running: false,
            bind: None,
            addr: None,
            base_url: None,
            websocket_url: None,
        }
    }
}

fn normalise_pairing_url(public_url: Option<String>, fallback: Option<String>) -> String {
    let raw = public_url
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .or(fallback)
        .unwrap_or_else(|| format!("http://{DEFAULT_BIND}"));
    if raw.starts_with("http://") || raw.starts_with("https://") || raw.starts_with("ws://") || raw.starts_with("wss://") {
        raw
    } else {
        format!("http://{raw}")
    }
}

fn url_to_ws(url: &str) -> String {
    let ws = if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        url.to_string()
    };
    if ws.ends_with("/ws") {
        ws
    } else {
        format!("{}/ws", ws.trim_end_matches('/'))
    }
}

impl MobileSyncShared {
    fn snapshot_raw(&self) -> String {
        if let Ok(latest) = self.latest_state.lock() {
            if let Some(raw) = latest.as_ref() {
                return raw.clone();
            }
        }
        state::state_load()
    }

    fn snapshot_value(&self) -> AppResult<Value> {
        let raw = self.snapshot_raw();
        if raw.trim().is_empty() {
            return Ok(json!({
                "version": null,
                "sessions": [],
                "windowsBySession": {},
                "agentsBySession": {},
                "sessionOrder": [],
                "activeSessionId": null,
            }));
        }
        serde_json::from_str(&raw).map_err(AppError::from)
    }
}

#[tauri::command]
pub async fn mobile_sync_start(
    app: AppHandle,
    manager: State<'_, Arc<MobileSyncManager>>,
    bind: Option<String>,
) -> AppResult<MobileSyncStatus> {
    let bind = bind
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var(ENV_BIND).ok())
        .unwrap_or_else(|| DEFAULT_BIND.to_string());
    manager.start(bind, app).await
}

#[tauri::command]
pub fn mobile_sync_stop(manager: State<'_, Arc<MobileSyncManager>>) -> AppResult<MobileSyncStatus> {
    manager.stop()
}

#[tauri::command]
pub fn mobile_sync_status(
    manager: State<'_, Arc<MobileSyncManager>>,
) -> AppResult<MobileSyncStatus> {
    manager.status()
}

#[tauri::command]
pub fn mobile_sync_pairing_info(
    manager: State<'_, Arc<MobileSyncManager>>,
) -> AppResult<MobileSyncPairingInfo> {
    manager.pairing_info()
}

#[tauri::command]
pub fn mobile_sync_pairing_qr(
    manager: State<'_, Arc<MobileSyncManager>>,
    public_url: Option<String>,
) -> AppResult<MobileSyncPairingQr> {
    manager.pairing_qr(public_url)
}

#[tauri::command]
pub fn mobile_sync_update_state(
    manager: State<'_, Arc<MobileSyncManager>>,
    data: String,
) -> AppResult<()> {
    manager.update_state(data)
}

pub fn autostart_from_env(manager: Arc<MobileSyncManager>, app: AppHandle) {
    let enabled = std::env::var(ENV_ENABLE)
        .ok()
        .map(|v| {
            matches!(
                v.as_str(),
                "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"
            )
        })
        .unwrap_or(false);
    if !enabled {
        return;
    }
    let bind = std::env::var(ENV_BIND).unwrap_or_else(|_| DEFAULT_BIND.to_string());
    tauri::async_runtime::spawn(async move {
        if let Err(err) = manager.start(bind, app).await {
            eprintln!("sikemux mobile sync autostart failed: {err}");
        }
    });
}

async fn health_route() -> Json<Value> {
    Json(json!({
        "ok": true,
        "app": "sikemux",
        "service": "mobile-sync",
    }))
}

async fn state_route(
    AxumState(http): AxumState<HttpState>,
    Query(auth): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &auth, &http.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match http.shared.snapshot_value() {
        Ok(value) => Json(value).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    }
}

async fn ws_route(
    ws: WebSocketUpgrade,
    AxumState(http): AxumState<HttpState>,
    Query(auth): Query<AuthQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &auth, &http.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| websocket_loop(socket, http))
        .into_response()
}

async fn websocket_loop(socket: WebSocket, http: HttpState) {
    let (mut sender, mut receiver) = socket.split();
    let mut state_rx = http.shared.state_tx.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut attached_pty: Option<(u32, u32)> = None; // (pty_id, mobile_sub_id)
    let mut pty_rx: Option<mpsc::UnboundedReceiver<Vec<u8>>> = None;

    let hello = json!({
        "type": "hello",
        "app": "sikemux",
        "service": "mobile-sync",
        "protocol": 1,
    });
    if sender.send(Message::Text(hello.to_string())).await.is_err() {
        return;
    }

    if let Ok(snapshot) = http.shared.snapshot_value() {
        let event = json!({ "type": "state.snapshot", "state": snapshot });
        if sender.send(Message::Text(event.to_string())).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let event = json!({ "type": "heartbeat" });
                if sender.send(Message::Text(event.to_string())).await.is_err() {
                    break;
                }
            }
            state = state_rx.recv() => {
                match state {
                    Ok(raw) => {
                        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                            let event = json!({ "type": "state.changed", "state": value });
                            if sender.send(Message::Text(event.to_string())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if let Ok(snapshot) = http.shared.snapshot_value() {
                            let event = json!({ "type": "state.snapshot", "state": snapshot, "reason": "lagged" });
                            if sender.send(Message::Text(event.to_string())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            chunk = async {
                match pty_rx.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            }, if pty_rx.is_some() => {
                let Some(chunk) = chunk else {
                    pty_rx = None;
                    attached_pty = None;
                    continue;
                };
                let Some((pty_id, sub_id)) = attached_pty else {
                    continue;
                };
                let eof = chunk.is_empty();
                let event = json!({
                    "type": "pty.output",
                    "ptyId": pty_id,
                    "data": STANDARD.encode(&chunk),
                    "eof": eof,
                });
                if sender.send(Message::Text(event.to_string())).await.is_err() {
                    break;
                }
                if eof {
                    if let Some(manager) = http.app.try_state::<PtyManager>() {
                        manager.mobile_unsubscribe(pty_id, sub_id);
                    }
                    pty_rx = None;
                    attached_pty = None;
                }
            }
            message = receiver.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let reply = handle_client_message(&http, &mut attached_pty, &mut pty_rx, &text).await;
                        if sender.send(Message::Text(reply.to_string())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        if sender.send(Message::Pong(bytes)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    if let Some((pty_id, sub_id)) = attached_pty {
        if let Some(manager) = http.app.try_state::<PtyManager>() {
            manager.mobile_unsubscribe(pty_id, sub_id);
        }
    }
}

async fn handle_client_message(
    http: &HttpState,
    attached_pty: &mut Option<(u32, u32)>,
    pty_rx: &mut Option<mpsc::UnboundedReceiver<Vec<u8>>>,
    text: &str,
) -> Value {
    let value = match serde_json::from_str::<Value>(text) {
        Ok(value) => value,
        Err(_) => return error_event("message must be valid JSON"),
    };
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return error_event("message must include a type field");
    };

    match kind {
        "ping" => json!({ "type": "pong" }),
        "pty.list" => {
            let Some(manager) = http.app.try_state::<PtyManager>() else {
                return error_event("pty manager unavailable");
            };
            json!({ "type": "pty.list", "ptys": manager.mobile_list() })
        }
        "pty.spawn" => {
            let cols = value
                .get("cols")
                .and_then(Value::as_u64)
                .and_then(|v| u16::try_from(v).ok())
                .unwrap_or(80);
            let rows = value
                .get("rows")
                .and_then(Value::as_u64)
                .and_then(|v| u16::try_from(v).ok())
                .unwrap_or(24);
            let cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
            let startup = value
                .get("startup")
                .and_then(Value::as_str)
                .map(str::to_string);
            let Some(manager) = http.app.try_state::<PtyManager>() else {
                return error_event("pty manager unavailable");
            };
            match pty_spawn(http.app.clone(), manager, cols, rows, cwd, startup).await {
                Ok(pty_id) => json!({ "type": "pty.spawned", "ptyId": pty_id }),
                Err(err) => error_event(&err.to_string()),
            }
        }
        "pty.attach" => {
            let Some(pty_id) = value
                .get("ptyId")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
            else {
                return error_event("pty.attach requires numeric ptyId");
            };
            let Some(manager) = http.app.try_state::<PtyManager>() else {
                return error_event("pty manager unavailable");
            };
            if let Some((old_pty, old_sub)) = attached_pty.take() {
                manager.mobile_unsubscribe(old_pty, old_sub);
            }
            match manager.mobile_attach(pty_id) {
                Ok(MobilePtyAttach {
                    sub_id,
                    snapshot,
                    rx,
                }) => {
                    *attached_pty = Some((pty_id, sub_id));
                    *pty_rx = Some(rx);
                    json!({
                        "type": "pty.snapshot",
                        "ptyId": pty_id,
                        "subId": sub_id,
                        "data": STANDARD.encode(snapshot),
                    })
                }
                Err(err) => error_event(&err.to_string()),
            }
        }
        "pty.detach" => {
            let Some(manager) = http.app.try_state::<PtyManager>() else {
                return error_event("pty manager unavailable");
            };
            if let Some((pty_id, sub_id)) = attached_pty.take() {
                manager.mobile_unsubscribe(pty_id, sub_id);
            }
            *pty_rx = None;
            json!({ "type": "pty.detached" })
        }
        "pty.resize" => {
            let Some(pty_id) = value
                .get("ptyId")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
            else {
                return error_event("pty.resize requires numeric ptyId");
            };
            let Some(cols) = value
                .get("cols")
                .and_then(Value::as_u64)
                .and_then(|v| u16::try_from(v).ok())
            else {
                return error_event("pty.resize requires numeric cols");
            };
            let Some(rows) = value
                .get("rows")
                .and_then(Value::as_u64)
                .and_then(|v| u16::try_from(v).ok())
            else {
                return error_event("pty.resize requires numeric rows");
            };
            let Some(manager) = http.app.try_state::<PtyManager>() else {
                return error_event("pty manager unavailable");
            };
            match pty_resize(manager, pty_id, cols, rows) {
                Ok(()) => json!({ "type": "ack", "ok": true }),
                Err(err) => json!({ "type": "ack", "ok": false, "error": err.to_string() }),
            }
        }
        "pty.write" => {
            let Some(pty_id) = value
                .get("ptyId")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
            else {
                return error_event("pty.write requires numeric ptyId");
            };
            let data = value
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let client_msg_id = value.get("clientMsgId").cloned().unwrap_or(Value::Null);
            let Some(manager) = http.app.try_state::<PtyManager>() else {
                return error_event("pty manager unavailable");
            };
            match manager.mobile_write(pty_id, data.as_bytes().to_vec()).await {
                Ok(()) => json!({ "type": "ack", "ok": true, "clientMsgId": client_msg_id }),
                Err(err) => {
                    json!({ "type": "ack", "ok": false, "clientMsgId": client_msg_id, "error": err.to_string() })
                }
            }
        }
        other => error_event(&format!("unsupported message type: {other}")),
    }
}

fn error_event(message: &str) -> Value {
    json!({ "type": "error", "message": message })
}

fn authorized(headers: &HeaderMap, auth: &AuthQuery, token: &str) -> bool {
    if auth.token.as_deref() == Some(token) {
        return true;
    }
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(|bearer| constant_time_eq(bearer.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn ensure_pairing_token() -> AppResult<String> {
    let path = token_path()?;
    if let Ok(existing) = fs::read_to_string(&path) {
        let token = existing.trim().to_string();
        if !token.is_empty() {
            return Ok(token);
        }
    }

    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| AppError::Other(format!("token random: {e}")))?;
    let token = URL_SAFE_NO_PAD.encode(bytes);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&path, format!("{token}\n"))?;
    restrict_token_file(&path)?;
    Ok(token)
}

fn token_path() -> AppResult<PathBuf> {
    let home = std::env::var("HOME").map_err(|_| AppError::State("no home directory".into()))?;
    Ok(PathBuf::from(home).join(".config/sikemux").join(TOKEN_FILE))
}

#[cfg(unix)]
fn restrict_token_file(path: &PathBuf) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_token_file(_path: &PathBuf) -> AppResult<()> {
    Ok(())
}
