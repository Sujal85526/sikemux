use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

use serde_json::json;
use tempfile::TempDir;

use super::SimulatorManager;

const SECOND: Duration = Duration::from_secs(1);

/// Tests that drive a real simulator share it, so they take turns.
static REAL_DEVICE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn real_device() -> std::sync::MutexGuard<'static, ()> {
    REAL_DEVICE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
/// Long enough for a shell helper to start when every test starts one at once.
const PROMPT: Duration = Duration::from_secs(5);

/// Answers the way sikemux-sim does: `{"id":…,"ok":true,"result":{…}}` per request line.
const FAKE_HELPER: &str = r#"#!/bin/sh
echo '{"type":"ready","version":"sikemux-sim test"}'
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\1/')
  kind=$(printf '%s' "$line" | sed -E 's/.*"type":"([a-zA-Z]+)".*/\1/')
  case "$kind" in
    fail) echo "{\"id\":$id,\"ok\":false,\"error\":\"no simulator NOPE\"}" ;;
    crash) exit 3 ;;
    stall) sleep 30 ;;
    slow) (sleep 1; echo "{\"id\":$id,\"ok\":true,\"result\":{\"kind\":\"slow\",\"pid\":$$}}") & ;;
    *) echo "noise that is not JSON"; echo "{\"id\":$id,\"ok\":true,\"result\":{\"kind\":\"$kind\",\"pid\":$$}}" ;;
  esac
done
"#;

const UNAVAILABLE_HELPER: &str = r#"#!/bin/sh
echo '{"type":"unavailable","message":"CoreSimulator could not be loaded from the Xcode at /Library/Developer/CommandLineTools"}'
read -r line
exit 1
"#;

fn helper(script: &str) -> (TempDir, SimulatorManager) {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("sikemux-sim");
    std::fs::write(&path, script).expect("write helper");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    (dir, SimulatorManager::with_executable(Some(path)))
}

#[test]
fn answers_a_request_with_its_result() {
    let (_dir, manager) = helper(FAKE_HELPER);
    let result = manager
        .request("devices", json!({}), PROMPT)
        .expect("reply");
    assert_eq!(result["kind"], json!("devices"));
}

#[test]
fn sends_the_fields_alongside_the_type() {
    let (_dir, manager) = helper(FAKE_HELPER);
    let result = manager
        .request("tap", json!({ "udid": "A", "x": 1, "y": 2 }), PROMPT)
        .expect("reply");
    assert_eq!(result["kind"], json!("tap"));
}

#[test]
fn reports_the_helpers_error() {
    let (_dir, manager) = helper(FAKE_HELPER);
    assert_eq!(
        manager.request("fail", json!({}), PROMPT),
        Err("no simulator NOPE".into())
    );
}

#[test]
fn each_thread_gets_its_own_reply() {
    let (_dir, manager) = helper(FAKE_HELPER);
    std::thread::scope(|scope| {
        let slow = scope.spawn(|| manager.request("slow", json!({}), 2 * PROMPT));
        std::thread::sleep(Duration::from_millis(100));
        let quick = manager
            .request("state", json!({}), PROMPT)
            .expect("quick reply");
        assert_eq!(quick["kind"], json!("state"));
        assert_eq!(
            slow.join().unwrap().expect("slow reply")["kind"],
            json!("slow")
        );
    });
}

#[test]
fn a_crash_fails_the_waiting_request_and_the_next_one_restarts_the_helper() {
    let (_dir, manager) = helper(FAKE_HELPER);
    let first = manager
        .request("devices", json!({}), PROMPT)
        .expect("reply")["pid"]
        .clone();
    let started = Instant::now();
    assert_eq!(
        manager.request("crash", json!({}), 10 * SECOND),
        Err("the simulator helper stopped".into())
    );
    assert!(
        started.elapsed() < 5 * SECOND,
        "the crash was noticed only at the timeout"
    );
    let second = manager
        .request("devices", json!({}), PROMPT)
        .expect("reply after restart")["pid"]
        .clone();
    assert_ne!(first, second);
}

#[test]
fn gives_up_on_a_request_that_is_never_answered() {
    let (_dir, manager) = helper(FAKE_HELPER);
    let error = manager
        .request("stall", json!({}), Duration::from_millis(300))
        .unwrap_err();
    assert_eq!(error, "the simulator did not answer stall within 0 s");
    manager.drain();
}

#[test]
fn passes_on_why_the_simulator_is_unavailable() {
    let (_dir, manager) = helper(UNAVAILABLE_HELPER);
    let error = manager
        .request("devices", json!({}), 5 * SECOND)
        .unwrap_err();
    assert!(
        error.starts_with("CoreSimulator could not be loaded"),
        "{error}"
    );
}

#[test]
fn says_when_this_build_has_no_helper() {
    let manager = SimulatorManager::with_executable(None);
    let error = manager.request("devices", json!({}), PROMPT).unwrap_err();
    assert_eq!(
        error,
        "this build of Sikemux does not include the iOS Simulator helper"
    );
}

#[test]
fn rejects_fields_that_are_not_an_object() {
    let (_dir, manager) = helper(FAKE_HELPER);
    assert!(manager.request("tap", json!([1, 2]), PROMPT).is_err());
}

/// Talks to a real helper and Xcode: `SIKEMUX_SIM_EXECUTABLE=… cargo test --lib simulator -- --ignored`.
#[test]
#[ignore = "needs the sikemux-sim helper and Xcode's simulators"]
fn lists_the_real_simulators() {
    let _turn = real_device();
    let manager = SimulatorManager::default();
    let devices = manager
        .request("devices", json!({}), PROMPT)
        .expect("devices");
    let devices = devices["devices"].as_array().expect("a list of devices");
    assert!(!devices.is_empty(), "Xcode has no simulators");
    assert!(devices
        .iter()
        .all(|device| device["udid"].is_string() && device["booted"].is_boolean()));
}

mod tools {
    use serde_json::json;

    use super::helper;
    use crate::simulator::tools::{
        changes, choose_device, edge_warning, element_lines, elements_from, inspect, launching,
        run, tap_point, Device,
    };

    fn device(name: &str, os: &str, booted: bool) -> Device {
        Device {
            udid: format!("{name}-{os}"),
            name: name.into(),
            os: os.into(),
            booted,
            screen: Some((402.0, 874.0)),
        }
    }

    fn home_screen() -> serde_json::Value {
        let element = |kind: &str, label: &str, x: f64, y: f64| {
            json!({ "type": kind, "AXLabel": label, "AXValue": "", "AXUniqueId": label, "enabled": true, "traits": ["LaunchIcon"],
                    "frame": { "x": x, "y": y, "width": 68, "height": 90 } })
        };
        json!({ "elements": [
            { "type": "Application", "AXLabel": " ", "frame": { "x": 0, "y": 0, "width": 402, "height": 874 } },
            element("Button", "Settings", 306.0, 389.0),
            element("Button", "Safari", 24.0, 700.0),
            { "type": "GenericElement", "AXLabel": null, "frame": { "x": 0, "y": 0, "width": 10, "height": 10 } },
            { "type": "TextField", "AXLabel": "Search", "AXValue": "cats", "enabled": false,
              "frame": { "x": 10, "y": 10, "width": 100, "height": 30 } },
            element("Button", "Camera", 0.0, -60.0),
        ]})
    }

    #[test]
    fn picks_the_named_device_on_the_newest_ios_and_prefers_a_booted_one() {
        let devices = [
            device("iPhone 17", "iOS 26.0", false),
            device("iPhone 17", "iOS 27.0", false),
            device("iPad Air", "iOS 27.0", true),
        ];
        assert_eq!(
            choose_device(&devices, Some("iPhone 17")).unwrap().os,
            "iOS 27.0"
        );
        assert_eq!(
            choose_device(&devices, Some("iPhone 17-iOS 26.0"))
                .unwrap()
                .os,
            "iOS 26.0"
        );
        let booted = [
            device("iPhone 17", "iOS 27.0", false),
            device("iPhone 16e", "iOS 26.0", true),
        ];
        assert_eq!(choose_device(&booted, None).unwrap().name, "iPhone 16e");
        assert_eq!(
            choose_device(&devices, None).unwrap().udid,
            "iPhone 17-iOS 27.0"
        );
        assert!(choose_device(&devices, Some("Pixel 9"))
            .unwrap_err()
            .contains("sim_devices"));
        assert!(choose_device(&[device("iPad Air", "iOS 27.0", true)], None).is_err());
    }

    #[test]
    fn numbers_the_elements_a_person_could_act_on() {
        let (app, elements) = elements_from(&home_screen(), Some((402.0, 874.0)));
        assert_eq!(app, "Home Screen");
        assert_eq!(
            element_lines(&elements),
            vec![
                "0 Button \"Settings\" at (340, 434)",
                "1 Button \"Safari\" at (58, 745)",
                "2 TextField \"Search\" value=\"cats\" [disabled] at (60, 25)",
                "3 Button \"Camera\" [offscreen] at (34, -15)",
            ]
        );
    }

    #[test]
    fn taps_an_element_by_number_or_a_point() {
        let (_, elements) = elements_from(&home_screen(), Some((402.0, 874.0)));
        assert_eq!(tap_point(&elements, Some(1), None, None), Ok((58.0, 745.0)));
        assert_eq!(
            tap_point(&elements, None, Some(3.0), Some(4.0)),
            Ok((3.0, 4.0))
        );
        assert!(tap_point(&elements, Some(9), None, None)
            .unwrap_err()
            .contains("sim_state"));
        assert!(tap_point(&elements, None, Some(3.0), None).is_err());
    }

    #[test]
    fn an_alert_ios_draws_is_the_system_not_the_home_screen() {
        let alert = json!({ "elements": [
            { "type": "Application", "AXLabel": " ", "frame": { "x": 0, "y": 0, "width": 402, "height": 874 } },
            { "type": "Button", "AXLabel": "Allow Once", "traits": [], "frame": { "x": 56, "y": 458, "width": 290, "height": 48 } },
        ]});
        let (app, elements) = elements_from(&alert, Some((402.0, 874.0)));
        assert_eq!(app, "System");
        assert_eq!(
            element_lines(&elements),
            vec!["0 Button \"Allow Once\" at (201, 482)"]
        );
        let maps = json!({ "elements": [{ "type": "Application", "AXLabel": "Maps", "frame": { "x": 0, "y": 0, "width": 402, "height": 874 } }] });
        assert_eq!(elements_from(&maps, None).0, "Maps");
    }

    #[test]
    fn shows_text_as_a_person_reads_it() {
        let safari = json!({ "elements": [
            { "type": "Application", "AXLabel": "Safari", "frame": { "x": 0, "y": 0, "width": 402, "height": 874 } },
            { "type": "TextField", "AXLabel": "Address", "AXValue": "\u{200e}example.com\u{200f}", "frame": { "x": 30, "y": 800, "width": 340, "height": 32 } },
            { "type": "StaticText", "AXLabel": "Say \"hi\" \\ bye", "frame": { "x": 0, "y": 100, "width": 100, "height": 20 } },
        ]});
        let (_, elements) = elements_from(&safari, Some((402.0, 874.0)));
        assert_eq!(
            element_lines(&elements),
            vec![
                "0 TextField \"Address\" value=\"example.com\" at (200, 816)",
                "1 StaticText \"Say \\\"hi\\\" \\\\ bye\" at (50, 110)",
            ]
        );
    }

    #[test]
    fn tells_what_appeared_changed_and_went_away() {
        let (_, before) = elements_from(&home_screen(), Some((402.0, 874.0)));
        assert_eq!(changes(&before, &before), (vec![], vec![]));

        let mut after = before.clone();
        after[2].value = "dogs".into();
        after.remove(1);
        after.push(crate::simulator::tools::Element {
            role: "Button".into(),
            label: "Done".into(),
            value: String::new(),
            identifier: String::new(),
            enabled: true,
            center: (50.0, 50.0),
            offscreen: false,
        });
        let (changed, removed) = changes(&before, &after);
        assert_eq!(
            changed,
            vec![
                "1 TextField \"Search\" value=\"dogs\" [disabled] at (60, 25)",
                "3 Button \"Done\" at (50, 50)",
            ]
        );
        assert_eq!(removed, vec!["Button \"Safari\" at (58, 745)"]);
    }

    #[test]
    fn a_blank_launch_screen_is_not_a_settled_one() {
        let status_bar = json!({ "elements": [
            { "type": "Application", "AXLabel": " ", "frame": { "x": 0, "y": 0, "width": 402, "height": 874 } },
            { "type": "StaticText", "AXLabel": "9:27 PM", "frame": { "x": 60, "y": 20, "width": 44, "height": 26 } },
            { "type": "GenericElement", "AXLabel": "100% battery power", "frame": { "x": 330, "y": 20, "width": 36, "height": 26 } },
        ]});
        assert!(launching(&elements_from(&status_bar, Some((402.0, 874.0)))));
        assert!(!launching(&elements_from(
            &home_screen(),
            Some((402.0, 874.0))
        )));
    }

    #[test]
    fn warns_when_a_swipe_starts_at_an_edge() {
        let screen = Some((402.0, 874.0));
        assert!(edge_warning(screen, (200.0, 873.0))
            .unwrap()
            .contains("bottom"));
        assert!(edge_warning(screen, (1.0, 400.0)).unwrap().contains("left"));
        assert_eq!(edge_warning(screen, (200.0, 600.0)), None);
    }

    /// Answers each request type with a canned reply and records every request line.
    fn recording_helper(log: &std::path::Path) -> String {
        let state = home_screen().to_string().replace('"', "\\\"");
        format!(
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{log}'
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\1/')
  case "$line" in
    *'"type":"devices"'*) echo "{{\"id\":$id,\"ok\":true,\"result\":{{\"devices\":[{{\"udid\":\"U1\",\"name\":\"iPhone 17\",\"os\":\"iOS 27.0\",\"booted\":false,\"screen\":{{\"width\":402,\"height\":874}}}}]}}}}" ;;
    *'"type":"state"'*) echo "{{\"id\":$id,\"ok\":true,\"result\":{state}}}" ;;
    *) echo "{{\"id\":$id,\"ok\":true,\"result\":{{}}}}" ;;
  esac
done
"#,
            log = log.display()
        )
    }

    #[test]
    fn drags_through_each_point_in_order_and_lets_go() {
        let log_dir = tempfile::tempdir().unwrap();
        let log = log_dir.path().join("requests");
        let (_dir, manager) = helper(&recording_helper(&log));
        let call = |method: &str, params: serde_json::Value| {
            run(&manager, "agent-1", "/tmp", method, &params)
        };
        call("sim.attach", json!({})).expect("attach");

        call(
            "sim.touchPath",
            json!({ "points": [{ "x": 10, "y": 20 }, { "x": 30, "y": 40 }, { "x": 50, "y": 60 }], "duration": 0.1 }),
        )
        .expect("touch path");
        call(
            "sim.touch2Path",
            json!({ "points": [{ "x1": 100, "y1": 400, "x2": 300, "y2": 400 }, { "x1": 150, "y1": 400, "x2": 250, "y2": 400 }], "duration": 0.05 }),
        )
        .expect("pinch");
        assert!(
            call("sim.touchPath", json!({ "points": [{ "x": 1, "y": 2 }] }))
                .unwrap_err()
                .contains("two points")
        );
        assert!(call(
            "sim.touchPath",
            json!({ "points": [{ "x": 1 }, { "x": 2 }] })
        )
        .unwrap_err()
        .contains("x, y"));

        let steps: Vec<serde_json::Value> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .filter(|request| matches!(request["type"].as_str(), Some("touch" | "touch2")))
            .map(|request| {
                json!([
                    request["type"],
                    request["phase"],
                    request["x"].as_f64().or(request["x1"].as_f64())
                ])
            })
            .collect();
        assert_eq!(
            steps,
            vec![
                json!(["touch", "down", 10.0]),
                json!(["touch", "move", 30.0]),
                json!(["touch", "move", 50.0]),
                json!(["touch", "up", 50.0]),
                json!(["touch2", "down", 100.0]),
                json!(["touch2", "move", 150.0]),
                json!(["touch2", "up", 150.0]),
            ]
        );

        let detached = call("sim.detach", json!({})).expect("detach");
        assert_eq!(detached["udid"], json!("U1"));
        assert!(call("sim.state", json!({}))
            .unwrap_err()
            .contains("sim_attach"));
    }

    #[test]
    fn an_agent_attaches_reads_and_taps_by_number() {
        let log_dir = tempfile::tempdir().unwrap();
        let log = log_dir.path().join("requests");
        let (_dir, manager) = helper(&recording_helper(&log));
        let call = |method: &str, params: serde_json::Value| {
            run(&manager, "agent-1", "/tmp", method, &params)
        };

        assert_eq!(
            call("sim.tap", json!({ "index": 0 })).unwrap_err(),
            "no simulator is attached; call sim_attach first"
        );
        let attached = call("sim.attach", json!({})).expect("attach");
        assert_eq!(attached["device"], json!("iPhone 17 (iOS 27.0)"));
        assert_eq!(attached["app"], json!("Home Screen"));
        assert!(attached["shown"]
            .as_str()
            .unwrap()
            .starts_with("live on your desk"));
        assert_eq!(
            attached["elements"][0],
            json!("0 Button \"Settings\" at (340, 434)")
        );

        assert_eq!(
            call("sim.tap", json!({ "index": 0 })).expect("tap")["changes"],
            json!("none")
        );
        let full = call("sim.tap", json!({ "index": 0, "report": "full" })).expect("tap");
        assert_eq!(
            full["elements"][0],
            json!("0 Button \"Settings\" at (340, 434)")
        );
        let outcome = call("sim.tap", json!({ "index": 0, "report": "outcome" })).expect("tap");
        assert!(
            outcome.get("elements").is_none() && outcome.get("changes").is_none(),
            "{outcome}"
        );
        assert!(call("sim.tap", json!({ "index": 0, "report": "everything" })).is_err());
        let devices = call("sim.devices", json!({})).expect("devices");
        assert_eq!(devices["devices"][0]["attached"], json!(true));
        assert_eq!(
            inspect(&manager, Some("agent-1"))["attached"],
            json!({ "udid": "U1", "name": "iPhone 17", "os": "iOS 27.0" })
        );
        assert_eq!(inspect(&manager, Some("agent-2"))["attached"], json!(null));
        let other_agent = run(&manager, "agent-2", "/tmp", "sim.state", &json!({}));
        assert!(other_agent.is_err(), "attachments belong to one agent");

        let requests = std::fs::read_to_string(&log).unwrap();
        assert!(
            requests.contains(r#""type":"boot""#) && requests.contains(r#""udid":"U1""#),
            "{requests}"
        );
        let tap = requests
            .lines()
            .find(|line| line.contains(r#""type":"tap""#))
            .expect("a tap was sent");
        let tap: serde_json::Value = serde_json::from_str(tap).unwrap();
        assert_eq!(
            (tap["x"].as_f64(), tap["y"].as_f64()),
            (Some(340.0), Some(434.0))
        );
    }

    /// Drives the fixture app the way an agent would, through every kind of tool:
    /// `pnpm build:sim-fixture`, then
    /// `SIKEMUX_SIM_EXECUTABLE=… SIKEMUX_SIM_FIXTURE=…/SimFixture.app cargo test --lib simulator -- --ignored`.
    #[test]
    #[ignore = "needs the sikemux-sim helper, Xcode's simulators and the fixture app"]
    fn an_agent_drives_the_fixture_app() {
        let _turn = super::real_device();
        let fixture = std::env::var("SIKEMUX_SIM_FIXTURE")
            .expect("SIKEMUX_SIM_FIXTURE names the built SimFixture.app");
        let manager = crate::simulator::SimulatorManager::default();
        let call = |method: &str, params: serde_json::Value| {
            run(&manager, "agent-fixture", "/", method, &params)
                .unwrap_or_else(|error| panic!("{method}: {error}"))
        };
        let shows = |state: &serde_json::Value, text: &str| {
            let lines = state["elements"]
                .as_array()
                .or(state["changes"]["elements"].as_array());
            lines
                .into_iter()
                .flatten()
                .any(|line| line.as_str().unwrap().contains(text))
        };
        let device = std::env::var("SIKEMUX_SIM_DEVICE").ok();
        call(
            "sim.attach",
            device.map_or_else(|| json!({}), |device| json!({ "device": device })),
        );
        call("sim.install", json!({ "path": fixture }));

        let opened = call(
            "sim.launch",
            json!({ "bundleId": "com.nodelike.sikemux.simfixture" }),
        );
        assert_eq!(opened["app"], json!("SimFixture"), "{opened}");
        assert!(shows(&opened, "Count: 0"), "{opened}");

        let tapped = call("sim.tap", json!({ "label": "Add one" }));
        assert!(shows(&tapped, "Count: 1"), "{tapped}");

        call("sim.tap", json!({ "label": "field" }));
        let typed = call("sim.type", json!({ "text": "Hi there 42" }));
        assert!(shows(&typed, "Echo: Hi there 42"), "{typed}");

        let zoom = call("sim.state", json!({}))["elements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap())
            .find(|line| line.contains("Zoom: 1.0"))
            .expect("the zoom view")
            .to_owned();
        let centre: Vec<f64> = zoom
            .rsplit_once(" at (")
            .unwrap()
            .1
            .trim_end_matches(')')
            .split(", ")
            .map(|n| n.parse().unwrap())
            .collect();
        let pinched = call(
            "sim.touch2Path",
            json!({ "points": [
                { "x1": centre[0] - 20.0, "y1": centre[1], "x2": centre[0] + 20.0, "y2": centre[1] },
                { "x1": centre[0] - 120.0, "y1": centre[1], "x2": centre[0] + 120.0, "y2": centre[1] },
            ], "duration": 0.5 }),
        );
        assert!(
            !shows(&pinched, "Zoom: 1.0"),
            "spreading two fingers zooms in: {pinched}"
        );

        call("sim.type", json!({ "text": "\n" }));
        let scrolled = call(
            "sim.swipe",
            json!({ "fromX": 200, "fromY": 780, "toX": 200, "toY": 520, "duration": 0.4 }),
        );
        assert!(
            shows(&scrolled, "Row 1") || shows(&scrolled, "Row 2"),
            "the list is on screen: {scrolled}"
        );

        let logged = call("sim.logs", json!({ "process": "SimFixture" }));
        let lines = logged["lines"].as_array().unwrap();
        assert!(
            lines
                .iter()
                .any(|line| line.as_str().unwrap().contains("tapped add one, count 1")),
            "{logged}"
        );

        call(
            "sim.terminate",
            json!({ "bundleId": "com.nodelike.sikemux.simfixture" }),
        );
        call("sim.detach", json!({}));
    }

    /// An agent's whole round on a real simulator:
    /// `SIKEMUX_SIM_EXECUTABLE=… cargo test --lib simulator -- --ignored`.
    #[test]
    #[ignore = "needs the sikemux-sim helper and Xcode's simulators"]
    fn an_agent_drives_a_real_simulator() {
        let _turn = super::real_device();
        let manager = crate::simulator::SimulatorManager::default();
        let call = |method: &str, params: serde_json::Value| {
            run(&manager, "agent-real", "/tmp", method, &params)
                .unwrap_or_else(|error| panic!("{method}: {error}"))
        };
        let attached = call(
            "sim.attach",
            std::env::var("SIKEMUX_SIM_DEVICE")
                .map_or_else(|_| json!({}), |device| json!({ "device": device })),
        );
        println!("attached: {}", attached["device"]);
        let home = call("sim.button", json!({ "button": "home" }));
        assert_eq!(home["app"], json!("Home Screen"), "{home}");
        let settings = call("sim.tap", json!({ "label": "Settings" }));
        assert_eq!(settings["app"], json!("Settings"), "{settings}");
        println!(
            "{}",
            settings["elements"]
                .as_array()
                .unwrap()
                .iter()
                .take(5)
                .map(|line| line.to_string())
                .collect::<Vec<_>>()
                .join("\n")
        );
        let shot = call("sim.screenshot", json!({}));
        assert_eq!(shot["mimeType"], json!("image/jpeg"));
        assert!(shot["data"].as_str().unwrap().len() > 1000);
        let back = call("sim.button", json!({ "button": "home" }));
        assert_eq!(back["app"], json!("Home Screen"));
    }
}

mod view {
    use std::io::{BufReader, Cursor, Read, Write};
    use std::net::TcpListener;

    use crate::simulator::view::relay;

    fn part(jpeg: &[u8]) -> Vec<u8> {
        let mut part = format!(
            "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
            jpeg.len()
        )
        .into_bytes();
        part.extend_from_slice(jpeg);
        part.extend_from_slice(b"\r\n");
        part
    }

    fn stream(parts: &[&[u8]]) -> Vec<u8> {
        let mut body =
            b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n"
                .to_vec();
        for jpeg in parts {
            body.extend(part(jpeg));
        }
        body
    }

    #[test]
    fn hands_over_each_frame_whole_until_the_stream_ends() {
        let mut frames = Vec::new();
        let body = stream(&[
            b"\xff\xd8one\xff\xd9",
            b"\xff\xd8\r\n\r\ntwo with blank lines\xff\xd9",
        ]);
        relay(BufReader::new(Cursor::new(body)), |frame| {
            frames.push(frame)
        })
        .expect("a clean end");
        assert_eq!(
            frames,
            vec![
                b"\xff\xd8one\xff\xd9".to_vec(),
                b"\xff\xd8\r\n\r\ntwo with blank lines\xff\xd9".to_vec()
            ]
        );
    }

    #[test]
    fn refuses_a_stream_that_was_not_found() {
        let body = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec();
        let error = relay(BufReader::new(Cursor::new(body)), |_| panic!("no frames")).unwrap_err();
        assert!(error.to_string().contains("404"), "{error}");
    }

    #[test]
    fn refuses_a_frame_too_large_to_be_a_screen() {
        let mut body = stream(&[]);
        body.extend_from_slice(b"--frame\r\nContent-Length: 999999999999\r\n\r\n");
        assert!(relay(BufReader::new(Cursor::new(body)), |_| panic!("no frames")).is_err());
    }

    #[test]
    fn reads_frames_from_a_local_stream_server() {
        let server = TcpListener::bind("127.0.0.1:0").expect("a port");
        let port = server.local_addr().unwrap().port();
        let serving = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().expect("a viewer");
            let mut request = [0u8; 256];
            let read = socket.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).starts_with("GET /token HTTP/1.1"));
            socket.write_all(&stream(&[b"first", b"second"])).unwrap();
        });
        let mut socket = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        socket
            .write_all(b"GET /token HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        let mut frames = Vec::new();
        relay(BufReader::new(socket), |frame| frames.push(frame)).expect("a clean end");
        serving.join().unwrap();
        assert_eq!(frames, vec![b"first".to_vec(), b"second".to_vec()]);
    }
}

mod release {
    use std::path::Path;

    use crate::simulator::{runnable, Published};

    const HELPER: Published = Published {
        asset: "sikemux-sim-aarch64-apple-darwin",
        size: 4,
        sha256: "abc",
    };

    #[test]
    fn a_dev_build_runs_the_helper_beside_it() {
        let local = Path::new("/dev/sikemux-sim");
        assert_eq!(
            runnable(Some(local), None, Some(&HELPER), |_, _| false),
            Ok(local)
        );
    }

    #[test]
    fn a_release_runs_the_downloaded_helper_only_once_it_is_the_published_one() {
        let downloaded = Path::new("/data/simulator/sikemux-sim");
        assert_eq!(
            runnable(None, Some(downloaded), Some(&HELPER), |_, _| true),
            Ok(downloaded)
        );
        assert!(
            runnable(None, Some(downloaded), Some(&HELPER), |_, _| false)
                .unwrap_err()
                .contains("still downloading")
        );
    }

    #[test]
    fn a_build_without_a_published_helper_says_so() {
        assert!(runnable(None, None, None, |_, _| true)
            .unwrap_err()
            .contains("does not include"));
    }
}

mod logs {
    use serde_json::json;

    use crate::simulator::logs::Lines;

    fn lines(text: &[&str]) -> Lines {
        let mut lines = Lines::default();
        for line in text {
            lines.push((*line).to_owned());
        }
        lines
    }

    #[test]
    fn reads_on_from_the_cursor_it_hands_back() {
        let kept = lines(&[
            "a Df Maps[1:2] one",
            "a Df Notes[3:4] two",
            "a Df Maps[1:2] three",
        ]);
        assert_eq!(
            kept.read(0, None, 2),
            json!({ "lines": ["a Df Maps[1:2] one", "a Df Notes[3:4] two"], "cursor": 2, "more": true })
        );
        assert_eq!(
            kept.read(2, None, 10),
            json!({ "lines": ["a Df Maps[1:2] three"], "cursor": 3, "more": false })
        );
    }

    #[test]
    fn keeps_one_process_by_its_exact_name() {
        let kept = lines(&[
            "a Df Maps[1:2] one",
            "a Df MapsWidget[5:6] two",
            "a Df Maps[1:2] three",
        ]);
        assert_eq!(
            kept.read(0, Some("Maps"), 10)["lines"],
            json!(["a Df Maps[1:2] one", "a Df Maps[1:2] three"])
        );
    }

    #[test]
    fn says_how_many_lines_went_before_a_slow_reader_came_back() {
        let mut kept = Lines::default();
        for number in 0..5_003 {
            kept.push(format!("t Df dasd[1:2] line {number}"));
        }
        let read = kept.read(0, None, 1);
        assert_eq!(read["dropped"], json!(3));
        assert_eq!(read["lines"], json!(["t Df dasd[1:2] line 3"]));
    }

    #[test]
    fn an_apps_lines_outlast_a_flood_from_system_services() {
        let mut kept = Lines::default();
        kept.push("t Df MyApp[9:9] launched".into());
        for number in 0..20_000 {
            kept.push(format!("t Df dasd[1:2] noise {number}"));
        }
        kept.push("t Df MyApp[9:9] tapped".into());
        assert_eq!(
            kept.read(0, Some("MyApp"), 10),
            json!({ "lines": ["t Df MyApp[9:9] launched", "t Df MyApp[9:9] tapped"], "cursor": 2, "more": false })
        );
        assert_eq!(kept.read(0, Some("Nobody"), 10)["lines"], json!([]));
    }
}
