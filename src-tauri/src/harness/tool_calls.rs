//! How often agents call each tool, and how often a call fails, so the tool
//! surface can be trimmed by what is used. The tally stays on this machine.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::HarnessRequest;

const FILE: &str = "agent-tool-calls.json";

#[derive(Default, Serialize, Deserialize, PartialEq, Debug)]
struct Tally {
    calls: u64,
    failures: u64,
}

/// A plugin tool is named by the agent's tool name, anything else by its
/// harness method. Listing plugin tools is not a call.
pub fn name_of(request: &HarnessRequest) -> Option<String> {
    match request.method.as_str() {
        "plugins.tools" => None,
        "plugins.call" => request
            .params
            .get("tool")
            .and_then(Value::as_str)
            .map(str::to_owned),
        method => Some(method.to_owned()),
    }
}

pub fn record(app: &AppHandle, tool: &str, succeeded: bool) {
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _held = ONE_AT_A_TIME.lock().unwrap_or_else(PoisonError::into_inner);
    if let Err(error) = add(&dir.join(FILE), tool, succeeded) {
        eprintln!("could not count a call to {tool}: {error}");
    }
}

fn add(path: &Path, tool: &str, succeeded: bool) -> std::io::Result<()> {
    let mut tallies: BTreeMap<String, Tally> = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let tally = tallies.entry(tool.to_owned()).or_default();
    tally.calls += 1;
    if !succeeded {
        tally.failures += 1;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(&tallies)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(method: &str, params: Value) -> HarnessRequest {
        HarnessRequest {
            id: "1".into(),
            project: "/project".into(),
            agent_id: Some("agent".into()),
            method: method.into(),
            params,
        }
    }

    #[test]
    fn a_plugin_call_is_counted_under_the_tool_the_agent_named() {
        assert_eq!(
            name_of(&request("plugins.call", json!({ "tool": "signoz_logs" }))).as_deref(),
            Some("signoz_logs")
        );
        assert_eq!(
            name_of(&request("browser.navigate", json!({}))).as_deref(),
            Some("browser.navigate")
        );
        assert_eq!(name_of(&request("plugins.tools", json!({}))), None);
    }

    #[test]
    fn calls_and_failures_add_up_across_writes() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("nested").join(FILE);
        add(&path, "browser.click", true).expect("counts");
        add(&path, "browser.click", false).expect("counts");
        add(&path, "task.start", true).expect("counts");
        let tallies: BTreeMap<String, Tally> =
            serde_json::from_slice(&std::fs::read(&path).expect("written")).expect("parses");
        assert_eq!(
            tallies.get("browser.click"),
            Some(&Tally {
                calls: 2,
                failures: 1
            })
        );
        assert_eq!(tallies.get("task.start").map(|tally| tally.calls), Some(1));
    }
}
