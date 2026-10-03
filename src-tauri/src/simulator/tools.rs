//! The agent's `sim_*` tools. Each agent attaches one simulator and acts on it
//! in device points; a person watching the same device sees every step.

use std::path::Path;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::SimulatorManager;
use sikemux_core::cli::protocol::HarnessRequest;

/// The sidecar stops waiting at 70 s, so a cold boot that runs longer is
/// reported as still going and finishes in the background.
const BOOT_TIMEOUT: Duration = Duration::from_secs(60);
const ACTION_TIMEOUT: Duration = Duration::from_secs(20);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(60);
const SETTLE_STEP: Duration = Duration::from_millis(300);
/// Enough reads for an app to finish launching, about three and a half seconds.
const SETTLE_READS: usize = 12;
/// Elements whose centre is above this are the status bar's: time, signal, battery.
const STATUS_BAR_HEIGHT: f64 = 60.0;
/// How many reads, a step apart, to wait for an action to change the screen.
const CHANGE_READS: usize = 5;
/// A swipe that starts this close to an edge is sent as a system gesture, as the helper decides.
const EDGE: f64 = 10.0;
const MAX_ELEMENTS: usize = 200;
/// An agent cannot see the person's screen, so attaching says where the device went.
const SHOWN_ON_DESK: &str =
    "live on your desk in Sikemux, beside the person, who sees what you do and can use it too";
/// Tells the window an agent let go of a simulator, so its desk can close the tab.
pub const DETACHED_EVENT: &str = "simulator-detached";
/// Tells the window an agent attached a simulator, so its desk can show it.
pub const ATTACHED_EVENT: &str = "simulator-attached";

pub fn execute(app: &AppHandle, request: &HarnessRequest) -> Result<Value, String> {
    let agent_id = request
        .agent_id
        .as_deref()
        .ok_or("simulator tools need the agent's id")?;
    let manager = app.state::<SimulatorManager>();
    let result = run(
        &manager,
        agent_id,
        &request.project,
        &request.method,
        &request.params,
    );
    if request.method == "sim.attach" && result.is_ok() {
        if let Some(device) = manager.attached(agent_id) {
            let _ = app.emit_to(
                "main",
                ATTACHED_EVENT,
                json!({
                    "agentId": agent_id,
                    "udid": device.udid,
                    "name": device.name,
                    "os": device.os,
                    "screen": device.screen.map(|(width, height)| json!({ "width": width, "height": height })),
                }),
            );
        }
    }
    if request.method == "sim.detach" {
        if let Ok(detached) = &result {
            let _ = app.emit_to(
                "main",
                DETACHED_EVENT,
                json!({ "agentId": agent_id, "udid": detached["udid"] }),
            );
        }
    }
    result
}

pub(super) fn run(
    manager: &SimulatorManager,
    agent_id: &str,
    project: &str,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let text = |key: &str| params.get(key).and_then(Value::as_str);
    let number = |key: &str| params.get(key).and_then(Value::as_f64);
    match method {
        "sim.devices" => {
            let attached = manager.attached(agent_id).map(|device| device.udid);
            let devices = list_devices(manager)?;
            Ok(json!({
                "devices": devices
                    .iter()
                    .map(|device| json!({
                        "udid": device.udid,
                        "name": device.name,
                        "os": device.os,
                        "booted": device.booted,
                        "attached": attached.as_deref() == Some(device.udid.as_str()),
                    }))
                    .collect::<Vec<_>>(),
            }))
        }
        "sim.attach" => {
            let devices = list_devices(manager)?;
            let device = choose_device(&devices, text("device"))?.clone();
            let booted = manager.request("boot", json!({ "udid": device.udid }), BOOT_TIMEOUT);
            if let Err(error) = booted {
                if error.starts_with("the simulator did not answer") {
                    return Err(format!(
                        "{} is still booting; call sim_attach again in a moment",
                        device.name
                    ));
                }
                return Err(error);
            }
            manager.attach(agent_id, device.clone());
            let _ = manager.logs.follow(&device.udid);
            let mut state = settled_state(manager, agent_id, None)?;
            state["shown"] = SHOWN_ON_DESK.into();
            Ok(state)
        }
        "sim.state" => settled_state(manager, agent_id, None),
        "sim.tap" => {
            let device = attached(manager, agent_id)?;
            let before = read_screen(manager, &device)?;
            let mut fields = json!({ "udid": device.udid });
            if let Some(label) = text("label") {
                manager.request(
                    "tapElement",
                    json!({ "udid": device.udid, "label": label }),
                    ACTION_TIMEOUT,
                )?;
            } else {
                let point = tap_point(
                    &manager.elements(agent_id),
                    params.get("index").and_then(Value::as_u64),
                    number("x"),
                    number("y"),
                )?;
                fields["x"] = point.0.into();
                fields["y"] = point.1.into();
                if let Some(duration) = number("duration") {
                    fields["duration"] = duration.into();
                }
                manager.request("tap", fields, ACTION_TIMEOUT)?;
            }
            settled_state(manager, agent_id, Some(before))
        }
        "sim.swipe" => {
            let device = attached(manager, agent_id)?;
            let before = read_screen(manager, &device)?;
            let from = (
                number("fromX").ok_or("fromX is required")?,
                number("fromY").ok_or("fromY is required")?,
            );
            let to = (
                number("toX").ok_or("toX is required")?,
                number("toY").ok_or("toY is required")?,
            );
            let mut fields = json!({ "udid": device.udid, "fromX": from.0, "fromY": from.1, "toX": to.0, "toY": to.1 });
            if let Some(duration) = number("duration") {
                fields["duration"] = duration.into();
            }
            manager.request("swipe", fields, ACTION_TIMEOUT)?;
            let mut state = settled_state(manager, agent_id, Some(before))?;
            if let Some(warning) = edge_warning(device.screen, from) {
                state["warning"] = warning.into();
            }
            Ok(state)
        }
        "sim.type" => {
            let device = attached(manager, agent_id)?;
            let before = read_screen(manager, &device)?;
            let typed = text("text").ok_or("text is required")?;
            manager.request(
                "type",
                json!({ "udid": device.udid, "text": typed }),
                ACTION_TIMEOUT,
            )?;
            settled_state(manager, agent_id, Some(before))
        }
        "sim.button" => {
            let device = attached(manager, agent_id)?;
            let before = read_screen(manager, &device)?;
            let button = text("button").ok_or("button is required")?;
            manager.request(
                "button",
                json!({ "udid": device.udid, "button": button }),
                ACTION_TIMEOUT,
            )?;
            settled_state(manager, agent_id, Some(before))
        }
        "sim.screenshot" => {
            let device = attached(manager, agent_id)?;
            let file = tempfile::Builder::new()
                .prefix("sikemux-sim-")
                .suffix(".jpg")
                .tempfile()
                .map_err(|error| format!("no room for a screenshot: {error}"))?;
            let shot = manager.request(
                "screenshot",
                json!({ "udid": device.udid, "path": file.path(), "format": "jpeg", "pointSize": true }),
                ACTION_TIMEOUT,
            )?;
            let bytes = std::fs::read(file.path())
                .map_err(|error| format!("could not read the screenshot: {error}"))?;
            Ok(json!({
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                "mimeType": "image/jpeg",
                "title": format!("{} ({})", device.name, device.os),
                "width": shot["width"],
                "height": shot["height"],
            }))
        }
        "sim.launch" => {
            let device = attached(manager, agent_id)?;
            let before = read_screen(manager, &device)?;
            let mut fields = json!({ "udid": device.udid, "bundleId": text("bundleId").ok_or("bundleId is required")? });
            for key in ["arguments", "environment"] {
                if let Some(value) = params.get(key) {
                    fields[key] = value.clone();
                }
            }
            let launched = manager.request("launch", fields, ACTION_TIMEOUT)?;
            let mut state = settled_state(manager, agent_id, Some(before))?;
            state["pid"] = launched["pid"].clone();
            Ok(state)
        }
        "sim.terminate" => {
            let device = attached(manager, agent_id)?;
            let before = read_screen(manager, &device)?;
            let bundle = text("bundleId").ok_or("bundleId is required")?;
            manager.request(
                "terminate",
                json!({ "udid": device.udid, "bundleId": bundle }),
                ACTION_TIMEOUT,
            )?;
            settled_state(manager, agent_id, Some(before))
        }
        "sim.install" => {
            let device = attached(manager, agent_id)?;
            let path = Path::new(project).join(text("path").ok_or("path is required")?);
            if !path.exists() {
                return Err(format!("no app at {}", path.display()));
            }
            manager.request(
                "install",
                json!({ "udid": device.udid, "path": path }),
                INSTALL_TIMEOUT,
            )
        }
        "sim.openUrl" => {
            let device = attached(manager, agent_id)?;
            let before = read_screen(manager, &device)?;
            let url = text("url").ok_or("url is required")?;
            manager.request(
                "openUrl",
                json!({ "udid": device.udid, "url": url }),
                ACTION_TIMEOUT,
            )?;
            settled_state(manager, agent_id, Some(before))
        }
        "sim.touchPath" => {
            let device = attached(manager, agent_id)?;
            let before = read_screen(manager, &device)?;
            let points = path(params, &["x", "y"])?;
            drag(
                manager,
                &device,
                &points,
                number("duration"),
                |phase, point| {
                    (
                        "touch",
                        json!({ "phase": phase, "x": point[0], "y": point[1] }),
                    )
                },
            )?;
            settled_state(manager, agent_id, Some(before))
        }
        "sim.touch2Path" => {
            let device = attached(manager, agent_id)?;
            let before = read_screen(manager, &device)?;
            let points = path(params, &["x1", "y1", "x2", "y2"])?;
            drag(
                manager,
                &device,
                &points,
                number("duration"),
                |phase, point| {
                    (
                        "touch2",
                        json!({ "phase": phase, "x1": point[0], "y1": point[1], "x2": point[2], "y2": point[3] }),
                    )
                },
            )?;
            settled_state(manager, agent_id, Some(before))
        }
        "sim.detach" => {
            let device = manager.detach(agent_id).ok_or("no simulator is attached")?;
            manager.logs.stop(&device.udid);
            Ok(
                json!({ "detached": format!("{} ({})", device.name, device.os), "udid": device.udid }),
            )
        }
        "sim.logs" => {
            let device = attached(manager, agent_id)?;
            let cursor = params.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            let limit = params
                .get("limit")
                .and_then(Value::as_u64)
                .map(|limit| limit as usize);
            manager
                .logs
                .read(&device.udid, cursor, text("process"), limit)
        }
        other => Err(format!("unknown simulator method {other}")),
    }
}

/// What `workspace_inspect` says about simulators: whether this Mac can run
/// them, and the device the agent has attached, so an agent does not reach for
/// `sim_*` on a Mac without Xcode.
pub fn inspect(manager: &SimulatorManager, agent_id: Option<&str>) -> Value {
    let attached = agent_id.and_then(|agent_id| manager.attached(agent_id));
    json!({
        "available": super::offered(),
        "attached": attached.map(|device| json!({ "udid": device.udid, "name": device.name, "os": device.os })),
    })
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Device {
    pub udid: String,
    pub name: String,
    pub os: String,
    pub booted: bool,
    /// Width and height in points.
    pub screen: Option<(f64, f64)>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Element {
    pub role: String,
    pub label: String,
    pub value: String,
    pub identifier: String,
    pub enabled: bool,
    pub center: (f64, f64),
    /// Scrolled out of view, or under the screen's edge, so it cannot be tapped.
    pub offscreen: bool,
}

pub(super) fn list_devices(manager: &SimulatorManager) -> Result<Vec<Device>, String> {
    let reply = manager.request("devices", json!({}), ACTION_TIMEOUT)?;
    Ok(reply["devices"]
        .as_array()
        .map(|devices| devices.iter().filter_map(device_from).collect())
        .unwrap_or_default())
}

fn device_from(value: &Value) -> Option<Device> {
    let screen = value.get("screen").and_then(|screen| {
        Some((
            screen.get("width")?.as_f64()?,
            screen.get("height")?.as_f64()?,
        ))
    });
    Some(Device {
        udid: value.get("udid")?.as_str()?.to_owned(),
        name: value.get("name")?.as_str()?.to_owned(),
        os: value
            .get("os")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        booted: value
            .get("booted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        screen,
    })
}

/// A named device by udid or name, newest iOS first when a name repeats; with no
/// name, the iPhone already booted, else an iPhone on the newest iOS.
pub(super) fn choose_device<'a>(
    devices: &'a [Device],
    wanted: Option<&str>,
) -> Result<&'a Device, String> {
    let newest = |candidates: Vec<&'a Device>| {
        candidates.into_iter().max_by(|a, b| {
            (a.booted, os_version(&a.os))
                .partial_cmp(&(b.booted, os_version(&b.os)))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    };
    let chosen = match wanted {
        Some(wanted) => devices
            .iter()
            .find(|device| device.udid == wanted)
            .or_else(|| {
                newest(
                    devices
                        .iter()
                        .filter(|device| device.name == wanted)
                        .collect(),
                )
            }),
        None => newest(
            devices
                .iter()
                .filter(|device| device.name.starts_with("iPhone"))
                .collect(),
        ),
    };
    chosen.ok_or_else(|| match wanted {
        Some(wanted) => format!(
            "no simulator is named {wanted}; sim_devices lists them, and Xcode's Devices and Simulators window adds more"
        ),
        None => "no iPhone simulator is installed; add one in Xcode's Devices and Simulators window".into(),
    })
}

fn os_version(os: &str) -> Vec<u32> {
    os.rsplit(' ')
        .next()
        .unwrap_or_default()
        .split('.')
        .filter_map(|part| part.parse().ok())
        .collect()
}

fn attached(manager: &SimulatorManager, agent_id: &str) -> Result<Device, String> {
    manager
        .attached(agent_id)
        .ok_or_else(|| "no simulator is attached; call sim_attach first".into())
}

pub(super) type Screen = (String, Vec<Element>);

fn read_screen(manager: &SimulatorManager, device: &Device) -> Result<Screen, String> {
    let reply = manager.request("state", json!({ "udid": device.udid }), ACTION_TIMEOUT)?;
    Ok(elements_from(&reply, device.screen))
}

/// Reads the screen until two reads agree, so an animation has finished before
/// the agent is told what is on screen. After an action it first waits for the
/// screen to change from `before`, because an app can take a moment to start
/// leaving and would otherwise read as settled on its way out.
fn settled_state(
    manager: &SimulatorManager,
    agent_id: &str,
    before: Option<Screen>,
) -> Result<Value, String> {
    let device = attached(manager, agent_id)?;
    let mut latest = read_screen(manager, &device)?;
    if let Some(before) = before {
        for _ in 0..CHANGE_READS {
            if latest != before {
                break;
            }
            std::thread::sleep(SETTLE_STEP);
            latest = read_screen(manager, &device)?;
        }
    }
    for _ in 1..SETTLE_READS {
        std::thread::sleep(SETTLE_STEP);
        let next = read_screen(manager, &device)?;
        let settled = next == latest && !launching(&next);
        latest = next;
        if settled {
            break;
        }
    }
    let (app, elements) = latest;
    let lines = element_lines(&elements);
    manager.remember_elements(agent_id, elements);
    let mut state = json!({
        "device": format!("{} ({})", device.name, device.os),
        "app": app,
        "elements": lines,
    });
    if let Some((width, height)) = device.screen {
        state["screen"] = json!({ "width": width, "height": height });
    }
    Ok(state)
}

/// What iOS itself draws, rather than an app, is the home screen when its app icons are
/// showing, and otherwise an alert, Control Center, the lock screen or a launch screen.
const HOME_SCREEN: &str = "Home Screen";
const SYSTEM: &str = "System";

/// An app on its way in shows a blank launch screen that no app owns yet, so
/// nothing but the status bar can be read.
pub(super) fn launching(screen: &Screen) -> bool {
    let (app, elements) = screen;
    app == SYSTEM
        && elements
            .iter()
            .all(|element| element.center.1 < STATUS_BAR_HEIGHT)
}

/// The frontmost app's name and its elements, from one accessibility read.
pub(super) fn elements_from(reply: &Value, screen: Option<(f64, f64)>) -> (String, Vec<Element>) {
    let mut app = String::new();
    let mut elements = Vec::new();
    let mut app_icons = false;
    for value in reply["elements"].as_array().into_iter().flatten() {
        app_icons |= value["traits"]
            .as_array()
            .is_some_and(|traits| traits.iter().any(|trait_| trait_ == "LaunchIcon"));
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(readable)
                .unwrap_or_default()
        };
        let role = text("type");
        if role == "Application" {
            app = text("AXLabel");
            continue;
        }
        let frame = &value["frame"];
        let (Some(x), Some(y), Some(width), Some(height)) = (
            frame["x"].as_f64(),
            frame["y"].as_f64(),
            frame["width"].as_f64(),
            frame["height"].as_f64(),
        ) else {
            continue;
        };
        if width <= 0.0 || height <= 0.0 {
            continue;
        }
        let label = text("AXLabel");
        let value_text = match value.get("AXValue") {
            Some(Value::String(text)) => readable(text),
            Some(Value::Number(number)) => number.to_string(),
            _ => String::new(),
        };
        if label.is_empty() && value_text.is_empty() && role == "GenericElement" {
            continue;
        }
        elements.push(Element {
            role,
            label,
            value: value_text,
            identifier: text("AXUniqueId"),
            enabled: value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            center: ((x + width / 2.0).round(), (y + height / 2.0).round()),
            offscreen: screen.is_some_and(|(screen_width, screen_height)| {
                let (center_x, center_y) = (x + width / 2.0, y + height / 2.0);
                center_x < 0.0
                    || center_y < 0.0
                    || center_x > screen_width
                    || center_y > screen_height
            }),
        });
    }
    if app.is_empty() {
        app = if app_icons { HOME_SCREEN } else { SYSTEM }.to_owned();
    }
    (app, elements)
}

/// Text as a person reads it: without the invisible marks that set reading
/// direction, which Safari puts around an address.
fn readable(text: &str) -> String {
    text.chars()
        .filter(|character| !matches!(character, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
        .collect::<String>()
        .trim()
        .to_owned()
}

fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// One line per element: `3 Button "General" at (201, 418)`.
pub(super) fn element_lines(elements: &[Element]) -> Vec<String> {
    let mut lines: Vec<String> = elements
        .iter()
        .take(MAX_ELEMENTS)
        .enumerate()
        .map(|(index, element)| {
            let mut line = format!("{index} {}", element.role);
            if !element.label.is_empty() {
                line.push_str(&format!(" {}", quoted(&element.label)));
            }
            if !element.value.is_empty() && element.value != element.label {
                line.push_str(&format!(" value={}", quoted(&element.value)));
            }
            if !element.identifier.is_empty() && element.identifier != element.label {
                line.push_str(&format!(" id={}", quoted(&element.identifier)));
            }
            if !element.enabled {
                line.push_str(" [disabled]");
            }
            if element.offscreen {
                line.push_str(" [offscreen]");
            }
            line.push_str(&format!(" at ({}, {})", element.center.0, element.center.1));
            line
        })
        .collect();
    if elements.len() > MAX_ELEMENTS {
        lines.push(format!(
            "… {} more; tap by label to reach them",
            elements.len() - MAX_ELEMENTS
        ));
    }
    lines
}

/// The points of a touch path, each with the given coordinates, from `params.points`.
fn path(params: &Value, keys: &[&str]) -> Result<Vec<Vec<f64>>, String> {
    let points: Vec<Vec<f64>> = params["points"]
        .as_array()
        .ok_or("points is required")?
        .iter()
        .map(|point| {
            keys.iter()
                .map(|key| point[*key].as_f64())
                .collect::<Option<Vec<f64>>>()
        })
        .collect::<Option<_>>()
        .ok_or_else(|| format!("each point needs {}", keys.join(", ")))?;
    if points.len() < 2 {
        return Err("a path needs at least two points".into());
    }
    Ok(points)
}

/// Puts the finger or fingers down on the first point, moves them through the
/// rest evenly over `duration` seconds, and lifts them on the last.
fn drag(
    manager: &SimulatorManager,
    device: &Device,
    points: &[Vec<f64>],
    duration: Option<f64>,
    step: impl Fn(&str, &[f64]) -> (&'static str, Value),
) -> Result<(), String> {
    let pause = Duration::from_secs_f64(duration.unwrap_or(0.5) / (points.len() - 1) as f64);
    let send = |phase: &str, point: &[f64]| {
        let (kind, mut fields) = step(phase, point);
        fields["udid"] = device.udid.clone().into();
        manager.request(kind, fields, ACTION_TIMEOUT).map(drop)
    };
    send("down", &points[0])?;
    for point in &points[1..] {
        std::thread::sleep(pause);
        send("move", point)?;
    }
    send("up", points.last().expect("at least two points"))
}

/// Where to tap: an element number from the latest read, or a point.
pub(super) fn tap_point(
    elements: &[Element],
    index: Option<u64>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(f64, f64), String> {
    if let Some(index) = index {
        let element = elements.get(index as usize).ok_or_else(|| {
            format!("no element {index} in the latest read; call sim_state for current numbers")
        })?;
        if element.offscreen {
            return Err(format!(
                "element {index} is off the screen; scroll it into view, then read again"
            ));
        }
        return Ok(element.center);
    }
    match (x, y) {
        (Some(x), Some(y)) => Ok((x, y)),
        _ => Err("give an element index, a label, or both x and y".into()),
    }
}

pub(super) fn edge_warning(screen: Option<(f64, f64)>, from: (f64, f64)) -> Option<String> {
    let (width, height) = screen?;
    let edge = if from.1 >= height - EDGE {
        "bottom"
    } else if from.1 <= EDGE {
        "top"
    } else if from.0 <= EDGE {
        "left"
    } else if from.0 >= width - EDGE {
        "right"
    } else {
        return None;
    };
    Some(format!(
        "the swipe started at the {edge} edge, which iOS treats as a system gesture (home, Notification Center, Control Center or back) rather than scrolling"
    ))
}
