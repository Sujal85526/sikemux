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

use super::tools::{list_devices, Device};
use super::SimulatorManager;
use crate::error::{AppError, AppResult};

pub const SCHEME: &str = "sim";
pub const FRAME_EVENT: &str = "simulator-frame";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// A first boot of a device, which also prepares its data, can take a couple of minutes.
const BOOT_TIMEOUT: Duration = Duration::from_secs(240);
/// A frame is a JPEG of a phone screen; anything far larger is not one.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct Views {
    views: Mutex<HashMap<String, View>>,
    /// The device drawn around each simulator's screen, once per device.
    chromes: Mutex<HashMap<String, Arc<Chrome>>>,
}

struct Chrome {
    layout: Value,
    image: Vec<u8>,
    mask: Vec<u8>,
}

struct View {
    viewers: usize,
    latest: Arc<Mutex<Option<Vec<u8>>>>,
    socket: TcpStream,
}

impl Views {
    /// Draws the device around `udid`'s screen the first time it is asked for. Without it the
    /// screen is shown bare, so a device Xcode has no artwork for still shows.
    fn chrome(&self, simulators: &SimulatorManager, udid: &str) -> Option<Arc<Chrome>> {
        let mut chromes = self
            .chromes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(chrome) = chromes.get(udid) {
            return Some(Arc::clone(chrome));
        }
        let folder = tempfile::tempdir().ok()?;
        let (image, mask) = (
            folder.path().join("chrome.png"),
            folder.path().join("mask.png"),
        );
        let layout = simulators
            .request(
                "chrome",
                json!({ "udid": udid, "chromePath": image, "maskPath": mask }),
                REQUEST_TIMEOUT,
            )
            .ok()?;
        let chrome = Arc::new(Chrome {
            layout,
            image: std::fs::read(&image).ok()?,
            mask: std::fs::read(&mask).ok()?,
        });
        chromes.insert(udid.to_owned(), Arc::clone(&chrome));
        Some(chrome)
    }

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
) -> AppResult<Option<Value>> {
    let layout = views
        .chrome(&simulators, &udid)
        .map(|chrome| chrome.layout.clone());
    if let Some(view) = views.lock().get_mut(&udid) {
        view.viewers += 1;
        return Ok(layout);
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
    Ok(layout)
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
    /// One step of a finger moving live; the window sends them one after another.
    Touch {
        phase: TouchPhase,
        x: f64,
        y: f64,
    },
    Button {
        button: String,
    },
    Type {
        text: String,
    },
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TouchPhase {
    Down,
    Move,
    Up,
}

#[tauri::command]
pub async fn simulator_input(
    simulators: State<'_, SimulatorManager>,
    udid: String,
    input: Input,
) -> AppResult<()> {
    let (kind, mut fields) = match input {
        Input::Touch { phase, x, y } => ("touch", json!({ "phase": phase, "x": x, "y": y })),
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    udid: String,
    name: String,
    os: String,
    booted: bool,
    screen: Option<Value>,
}

impl From<Device> for DeviceSummary {
    fn from(device: Device) -> Self {
        Self {
            screen: device
                .screen
                .map(|(width, height)| json!({ "width": width, "height": height })),
            udid: device.udid,
            name: device.name,
            os: device.os,
            booted: device.booted,
        }
    }
}

/// Every simulator Xcode has, for the person to pick from.
#[tauri::command]
pub async fn simulator_devices(
    simulators: State<'_, SimulatorManager>,
) -> AppResult<Vec<DeviceSummary>> {
    let devices = list_devices(&simulators).map_err(AppError::Other)?;
    Ok(devices.into_iter().map(DeviceSummary::from).collect())
}

/// Boots the device the person picked and makes it the agent's, so the person
/// and the agent keep looking at the same screen.
#[tauri::command]
pub async fn simulator_attach(
    simulators: State<'_, SimulatorManager>,
    agent_id: String,
    udid: String,
) -> AppResult<DeviceSummary> {
    let device = list_devices(&simulators)
        .map_err(AppError::Other)?
        .into_iter()
        .find(|device| device.udid == udid)
        .ok_or_else(|| AppError::Other(format!("no simulator {udid}")))?;
    simulators
        .request("boot", json!({ "udid": udid }), BOOT_TIMEOUT)
        .map_err(AppError::Other)?;
    simulators.attach(&agent_id, device.clone());
    Ok(DeviceSummary {
        booted: true,
        ..device.into()
    })
}

/// Saves the screen at full size to the Desktop as `name`, the way Simulator.app does.
#[tauri::command]
pub async fn simulator_save_screenshot(
    app: AppHandle,
    simulators: State<'_, SimulatorManager>,
    udid: String,
    name: String,
) -> AppResult<String> {
    let plain = std::path::Path::new(&name)
        .file_name()
        .is_some_and(|file| file == name.as_str());
    if !plain || !name.ends_with(".png") {
        return Err(AppError::BadArg(
            "a screenshot name is a plain .png file name",
        ));
    }
    let desktop = app
        .path()
        .desktop_dir()
        .map_err(|error| AppError::Other(format!("no Desktop folder: {error}")))?;
    let path = desktop.join(&name);
    simulators
        .request(
            "screenshot",
            json!({ "udid": udid, "path": path }),
            REQUEST_TIMEOUT,
        )
        .map_err(AppError::Other)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn simulator_shutdown(
    simulators: State<'_, SimulatorManager>,
    udid: String,
) -> AppResult<()> {
    simulators
        .request("shutdown", json!({ "udid": udid }), REQUEST_TIMEOUT)
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
/// `<udid>/chrome` and `<udid>/mask` are the device drawn around the screen and
/// the shape of the screen.
pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if context.webview_label() != "main" {
        responder.respond(status(StatusCode::FORBIDDEN));
        return;
    }
    let mut parts = request.uri().path().trim_start_matches('/').split('/');
    let udid = parts.next().unwrap_or_default().to_owned();
    let views = context.app_handle().state::<Views>();
    let chrome = || {
        views
            .chromes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&udid)
            .cloned()
    };
    let (body, kind) = match parts.next() {
        Some("chrome") => (chrome().map(|chrome| chrome.image.clone()), "image/png"),
        Some("mask") => (chrome().map(|chrome| chrome.mask.clone()), "image/png"),
        _ => (views.latest(&udid), "image/jpeg"),
    };
    responder.respond(match body {
        Some(image) => Response::builder()
            .header(header::CONTENT_TYPE, kind)
            .header(header::CACHE_CONTROL, "no-store")
            .body(image)
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
