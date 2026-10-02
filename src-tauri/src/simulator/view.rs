//! The live view of a simulator on the desk. The helper serves the screen as
//! MJPEG on a private local address; this reads it, keeps the latest frame, and
//! serves that frame to the window over `sim://` when told a new one arrived,
//! so frames never cross IPC and the address never reaches the page.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder};

use super::SimulatorManager;
use crate::error::{AppError, AppResult};

pub const SCHEME: &str = "sim";
pub const FRAME_EVENT: &str = "simulator-frame";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// A frame is a JPEG of a phone screen; anything far larger is not one.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct Views {
    views: Mutex<HashMap<String, View>>,
}

struct View {
    viewers: usize,
    latest: Arc<Mutex<Option<Vec<u8>>>>,
    socket: TcpStream,
}

impl Views {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, View>> {
        self.views
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn latest(&self, udid: &str) -> Option<Vec<u8>> {
        let latest = Arc::clone(&self.lock().get(udid)?.latest);
        let frame = latest
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        frame
    }
}

#[tauri::command]
pub async fn simulator_view_open(
    app: AppHandle,
    views: State<'_, Views>,
    simulators: State<'_, SimulatorManager>,
    udid: String,
) -> AppResult<()> {
    if let Some(view) = views.lock().get_mut(&udid) {
        view.viewers += 1;
        return Ok(());
    }
    let reply = simulators
        .request("stream", json!({ "udid": udid }), REQUEST_TIMEOUT)
        .map_err(AppError::Other)?;
    let url = reply["url"]
        .as_str()
        .ok_or_else(|| AppError::Other("the helper gave no stream address".into()))?;
    let latest: Arc<Mutex<Option<Vec<u8>>>> = Arc::default();
    let socket = connect(url)
        .map_err(|error| AppError::Other(format!("could not watch the simulator: {error}")))?;
    let reader = socket.try_clone()?;
    let frames = Arc::clone(&latest);
    let watched = udid.clone();
    std::thread::Builder::new()
        .name("sikemux-sim-view".into())
        .spawn(move || {
            let mut count = 0u64;
            let ended = relay(BufReader::new(reader), |frame| {
                *frames
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(frame);
                count += 1;
                let _ = app.emit_to(
                    "main",
                    FRAME_EVENT,
                    json!({ "udid": watched, "frame": count }),
                );
            });
            if let Err(error) = ended {
                let _ = app.emit_to(
                    "main",
                    FRAME_EVENT,
                    json!({ "udid": watched, "error": error.to_string() }),
                );
            }
        })?;
    views.lock().insert(
        udid,
        View {
            viewers: 1,
            latest,
            socket,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn simulator_view_close(
    views: State<'_, Views>,
    simulators: State<'_, SimulatorManager>,
    udid: String,
) -> AppResult<()> {
    let closed = {
        let mut views = views.lock();
        match views.get_mut(&udid) {
            Some(view) if view.viewers > 1 => {
                view.viewers -= 1;
                None
            }
            Some(_) => views.remove(&udid),
            None => None,
        }
    };
    if let Some(view) = closed {
        let _ = view.socket.shutdown(Shutdown::Both);
        let _ = simulators.request("stopStream", json!({ "udid": udid }), REQUEST_TIMEOUT);
    }
    Ok(())
}

/// What the person does in the view: the same requests the agent's tools send.
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Input {
    Tap {
        x: f64,
        y: f64,
        duration: Option<f64>,
    },
    Swipe {
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        duration: Option<f64>,
    },
    Button {
        button: String,
    },
    Type {
        text: String,
    },
}

#[tauri::command]
pub async fn simulator_input(
    simulators: State<'_, SimulatorManager>,
    udid: String,
    input: Input,
) -> AppResult<()> {
    let (kind, mut fields) = match input {
        Input::Tap { x, y, duration } => ("tap", json!({ "x": x, "y": y, "duration": duration })),
        Input::Swipe {
            from_x,
            from_y,
            to_x,
            to_y,
            duration,
        } => (
            "swipe",
            json!({ "fromX": from_x, "fromY": from_y, "toX": to_x, "toY": to_y, "duration": duration }),
        ),
        Input::Button { button } => ("button", json!({ "button": button })),
        Input::Type { text } => ("type", json!({ "text": text })),
    };
    if let Value::Object(map) = &mut fields {
        map.retain(|_, value| !value.is_null());
        map.insert("udid".into(), udid.into());
    }
    simulators
        .request(kind, fields, REQUEST_TIMEOUT)
        .map(drop)
        .map_err(AppError::Other)
}

/// Opens the helper's stream: `http://127.0.0.1:<port>/<token>`.
fn connect(url: &str) -> std::io::Result<TcpStream> {
    let invalid = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("not a local stream: {url}"),
        )
    };
    let rest = url.strip_prefix("http://127.0.0.1:").ok_or_else(invalid)?;
    let (port, path) = rest.split_once('/').ok_or_else(invalid)?;
    let port: u16 = port.parse().map_err(|_| invalid())?;
    let mut socket = TcpStream::connect(("127.0.0.1", port))?;
    write!(socket, "GET /{path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")?;
    Ok(socket)
}

/// Hands each JPEG in a multipart MJPEG response to `frame`, until the stream ends.
pub(super) fn relay(
    mut stream: impl BufRead,
    mut frame: impl FnMut(Vec<u8>),
) -> std::io::Result<()> {
    let status = read_line(&mut stream)?.unwrap_or_default();
    if !status.contains(" 200 ") {
        return Err(std::io::Error::other(format!(
            "the simulator stream answered {}",
            status.trim()
        )));
    }
    while read_line(&mut stream)?.is_some_and(|line| !line.trim().is_empty()) {}
    loop {
        let mut length = None;
        loop {
            let Some(line) = read_line(&mut stream)? else {
                return Ok(());
            };
            let line = line.trim();
            if line.is_empty() {
                if length.is_some() {
                    break;
                }
                continue;
            }
            if let Some(value) = line.strip_prefix("Content-Length:") {
                length = value.trim().parse::<usize>().ok();
            }
        }
        let length = length
            .filter(|length| *length <= MAX_FRAME_BYTES)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "a frame without a usable length",
                )
            })?;
        let mut jpeg = vec![0; length];
        stream.read_exact(&mut jpeg)?;
        frame(jpeg);
    }
}

fn read_line(stream: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut line = String::new();
    Ok((stream.read_line(&mut line)? > 0).then_some(line))
}

/// `sim://localhost/<udid>/<frame>` answers with that simulator's latest frame;
/// the frame number only keeps the window from reusing a cached one.
pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if context.webview_label() != "main" {
        responder.respond(status(StatusCode::FORBIDDEN));
        return;
    }
    let udid = request
        .uri()
        .path()
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or_default()
        .to_owned();
    let frame = context.app_handle().state::<Views>().latest(&udid);
    responder.respond(match frame {
        Some(jpeg) => Response::builder()
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::CACHE_CONTROL, "no-store")
            .body(jpeg)
            .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR)),
        None => status(StatusCode::NOT_FOUND),
    });
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .body(Vec::new())
        .unwrap_or_default()
}
