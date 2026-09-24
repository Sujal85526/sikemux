use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::PathBuf;
use std::thread::JoinHandle;

use super::*;

struct FakeSikemux {
    endpoint: PathBuf,
    served: JoinHandle<Value>,
    _directory: tempfile::TempDir,
}

/// Answers one harness frame the way the app's CLI broker does, and hands back
/// the frame it was asked.
fn fake_sikemux(answer: Value) -> FakeSikemux {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("a loopback port");
    let port = listener.local_addr().expect("a bound address").port();
    let directory = tempfile::tempdir().expect("a temporary directory");
    let endpoint = directory.path().join("endpoint.json");
    std::fs::write(
        &endpoint,
        json!({ "protocol": 1, "pid": 1, "port": port, "token": "test-token", "version": "test" })
            .to_string(),
    )
    .expect("the endpoint is written");
    let served = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("a client");
        let mut frame = String::new();
        BufReader::new(&stream)
            .read_line(&mut frame)
            .expect("a request frame");
        (&stream)
            .write_all(format!("{answer}\n").as_bytes())
            .expect("the answer is sent");
        serde_json::from_str(&frame).expect("the request is JSON")
    });
    FakeSikemux {
        endpoint,
        served,
        _directory: directory,
    }
}

impl FakeSikemux {
    fn relay(&self, method: &str, params: Value) -> Result<Value, String> {
        harness::relay(&self.endpoint, "/project", "agent-one", method, &params)
    }

    fn received(self) -> Value {
        self.served.join().expect("the fake app finished")
    }
}

fn declarations() -> Vec<Value> {
    Manifest::load().declarations()
}

fn field<'a>(tool: &'a Value, name: &str) -> &'a str {
    tool.get(name).and_then(Value::as_str).unwrap_or_default()
}

#[test]
fn every_served_tool_comes_from_the_manifest() {
    let manifest = Manifest::load();
    let served = manifest.declarations();
    let names: Vec<&str> = served.iter().map(|tool| field(tool, "name")).collect();
    for expected in [
        "browser_navigate",
        "workspace_inspect",
        "guide",
    ] {
        assert!(names.contains(&expected), "{expected} is not served");
    }
    let mut unique = names.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), names.len(), "a tool is declared twice");
    for name in &names {
        assert!(
            *name == manifest.guide_name() || manifest.tool(name).is_some(),
            "{name} has no harness method"
        );
    }
    for tool in &served {
        assert_eq!(tool["inputSchema"]["additionalProperties"], json!(false));
        assert_eq!(tool["inputSchema"]["type"], json!("object"));
    }
}

#[test]
fn tools_have_bounded_wait_and_required_idempotency() {
    let served = declarations();
    let tool = |name: &str| {
        served
            .iter()
            .find(|tool| field(tool, "name") == name)
            .unwrap_or_else(|| panic!("{name} is served"))
            .clone()
    };
    assert_eq!(
        tool("task_start")["inputSchema"]["required"],
        json!(["taskId", "idempotencyKey"])
    );
    assert_eq!(
        tool("events_wait")["inputSchema"]["properties"]["timeoutMs"]["maximum"],
        json!(30000)
    );
}

#[test]
fn schemas_stay_lean_so_prose_lives_in_the_guide() {
    let served = declarations();
    let mut prose = 0;
    for tool in &served {
        let description = field(tool, "description");
        assert!(
            description.len() <= 160,
            "{} description belongs in the guide",
            field(tool, "name")
        );
        prose += description.len();
    }
    assert!(
        prose <= 1800,
        "tool descriptions are paid on every request; explain it in SIKEMUX_GUIDE.md instead"
    );
}

#[test]
fn the_guide_explains_what_the_schemas_no_longer_say() {
    let manifest = Manifest::load();
    let guide = manifest.guide_text();
    for tool in manifest.declarations() {
        let name = field(&tool, "name");
        if name == manifest.guide_name() {
            continue;
        }
        assert!(guide.contains(name), "{name} is undocumented");
    }
    for trap in [
        "idempotencyKey",
        "trust",
        "previewUrl",
        "hasMore",
        "truncated",
        "escape sequences",
        "focus: true",
        "Element numbers expire",
        "not output cursors",
        "does not schedule",
    ] {
        assert!(guide.contains(trap), "the guide dropped '{trap}'");
    }
}

#[test]
fn agents_are_pointed_at_the_guide_before_they_start() {
    let manifest = Manifest::load();
    assert!(manifest.instructions().contains(manifest.guide_name()));
}

#[test]
fn browser_tools_are_answered_by_sikemux_for_this_agent() {
    let state = json!({ "url": "https://example.com", "title": "Example", "tabs": [] });
    let app = fake_sikemux(json!({ "status": "result", "value": state }));
    assert_eq!(
        app.relay("browser.navigate", json!({ "url": "example.com" })),
        Ok(state)
    );
    let received = app.received();
    assert_eq!(received["token"], json!("test-token"));
    assert_eq!(received["protocol"], json!(1));
    assert_eq!(received["command"], json!("harness"));
    assert_eq!(received["request"]["method"], json!("browser.navigate"));
    assert_eq!(
        received["request"]["params"],
        json!({ "url": "example.com" })
    );
    assert_eq!(received["request"]["agentId"], json!("agent-one"));
    assert_eq!(received["request"]["project"], json!("/project"));
    assert!(received["request"]["id"]
        .as_str()
        .is_some_and(|id| id.len() == 36));
}

#[test]
fn an_app_error_reaches_the_agent_as_a_tool_error() {
    let app = fake_sikemux(json!({ "status": "error", "message": "no browser tab is open" }));
    let manifest = Manifest::load();
    let tool = manifest.tool("browser_click").expect("browser_click");
    assert!(tool.validate(&json!({ "index": 3 })).is_ok());
    assert_eq!(
        app.relay(&tool.method, json!({ "index": 3 })),
        Err("no browser tab is open".into())
    );
}

#[test]
fn an_unreadable_answer_is_refused() {
    let app = fake_sikemux(json!({ "status": "accepted" }));
    assert_eq!(
        app.relay("workspace.inspect", json!({})),
        Err("Unexpected harness response".into())
    );
}

#[test]
fn a_missing_app_fails_without_a_connection() {
    assert_eq!(
        harness::relay(
            &PathBuf::from("/nonexistent/sikemux/cli.json"),
            "/project",
            "agent-one",
            "workspace.inspect",
            &json!({}),
        ),
        Err("Sikemux is not running".into())
    );
}

#[test]
fn a_missing_endpoint_variable_fails_without_connecting() {
    std::env::remove_var("SIKEMUX_CLI_ENDPOINT");
    assert_eq!(
        harness::call("agent-one", "workspace.inspect", &json!({})),
        Err("Missing SIKEMUX_CLI_ENDPOINT; launch this MCP from Sikemux".into())
    );
}

#[test]
fn the_guide_is_served_without_asking_the_app() {
    let manifest = Manifest::load();
    let answer = call(&manifest, "agent-one", manifest.guide_name(), &json!({}));
    assert_eq!(answer["isError"], json!(false));
    let body = field(&answer["content"][0], "text");
    assert!(body.contains("Working inside Sikemux"));
    assert!(body.contains("Element numbers expire"));
}

#[test]
fn unknown_tools_and_bad_agent_ids_are_refused() {
    assert!(validate_agent_id("../escape").is_err());
    assert!(validate_agent_id("").is_err());
    assert!(validate_agent_id(&"a".repeat(129)).is_err());
    assert_eq!(
        validate_agent_id("agent:one-2_3"),
        Ok("agent:one-2_3".into())
    );
    let manifest = Manifest::load();
    let answer = call(&manifest, "agent-one", "browser_evil", &json!({}));
    assert_eq!(answer["isError"], json!(true));
    assert_eq!(
        field(&answer["content"][0], "text"),
        "Unknown tool: browser_evil"
    );
}

#[test]
fn bad_arguments_are_named_the_way_the_agent_learned_them() {
    let manifest = Manifest::load();
    let complaint = |name: &str, arguments: Value| {
        manifest
            .tool(name)
            .expect("a declared tool")
            .validate(&arguments)
            .expect_err("the arguments are refused")
    };
    assert_eq!(
        complaint("browser_click", json!({ "index": "nope" })),
        "'nope' is not of type 'integer'"
    );
    assert_eq!(
        complaint("browser_click", json!({})),
        "'index' is a required property"
    );
    assert_eq!(
        complaint("browser_click", json!({ "index": 1, "extra": true })),
        "Additional properties are not allowed ('extra' was unexpected)"
    );
    assert_eq!(
        complaint("browser_click", json!({ "index": -1 })),
        "-1 is less than the minimum of 0"
    );
    assert_eq!(
        complaint(
            "events_wait",
            json!({ "cursor": "a", "timeoutMs": 99999 })
        ),
        "99999 is greater than the maximum of 30000"
    );
    assert_eq!(
        complaint("ui_open", json!({ "kind": "nope" })),
        "'nope' is not one of ['file', 'diff', 'terminal', 'preview']"
    );
    assert_eq!(
        complaint("browser_press", json!({ "key": "" })),
        "'' should be non-empty"
    );
    assert_eq!(
        complaint("browser_switch_tab", json!({ "tabId": "a".repeat(129) })),
        format!("'{}' is too long", "a".repeat(129))
    );
}

#[test]
fn a_screenshot_comes_back_as_an_image() {
    let blocks = content_for(
        "browser_screenshot",
        &json!({
            "data": "aGk=",
            "mimeType": "image/jpeg",
            "title": "Example",
            "url": "https://example.com",
        }),
    );
    assert_eq!(blocks[0]["type"], json!("image"));
    assert_eq!(blocks[0]["data"], json!("aGk="));
    assert_eq!(blocks[0]["mimeType"], json!("image/jpeg"));
    assert_eq!(field(&blocks[1], "text"), "Example https://example.com");
    assert_eq!(
        field(
            &content_for("browser_screenshot", &json!({ "data": "aGk=" }))[1],
            "text"
        ),
        "screenshot"
    );
    assert_eq!(
        field(
            &content_for("browser_state", &json!({ "tabs": [] }))[0],
            "text"
        ),
        "{\"tabs\":[]}"
    );
}

#[test]
fn a_host_is_answered_before_and_after_it_says_it_is_ready() {
    let manifest = Manifest::load();
    let answered = |initialized: bool, method: &str, params: Value| match route(
        &manifest,
        initialized,
        json!(7),
        method,
        params,
    ) {
        Route::Answer(answer) => answer,
        Route::Call { .. } => panic!("{method} should not reach the app"),
    };
    let start = answered(
        false,
        "initialize",
        json!({ "protocolVersion": "2025-06-18" }),
    );
    assert_eq!(start["result"]["protocolVersion"], json!("2025-06-18"));
    assert_eq!(
        start["result"]["serverInfo"]["name"],
        json!("sikemux-tools")
    );
    assert_eq!(
        start["result"]["capabilities"],
        json!({ "experimental": {}, "tools": { "listChanged": false } })
    );
    assert_eq!(
        answered(
            false,
            "initialize",
            json!({ "protocolVersion": "1999-01-01" })
        )["result"]["protocolVersion"],
        json!(LATEST_PROTOCOL_VERSION)
    );
    assert_eq!(
        answered(false, "tools/list", json!({}))["error"],
        json!({ "code": -32602, "message": "Invalid request parameters", "data": "" })
    );
    assert_eq!(answered(true, "ping", json!({}))["result"], json!({}));
    assert_eq!(
        answered(true, "resources/list", json!({}))["error"],
        json!({ "code": -32601, "message": "Method not found" })
    );
    let listed = answered(true, "tools/list", json!({}));
    assert_eq!(
        listed["result"]["tools"][0]["name"],
        json!("browser_navigate")
    );
    assert!(matches!(
        route(
            &manifest,
            true,
            json!(7),
            "tools/call",
            json!({ "name": "browser_state", "arguments": {} }),
        ),
        Route::Call { .. }
    ));
}
