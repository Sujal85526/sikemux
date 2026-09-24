//! Plugin tools for agents. They arrive through the same harness as the
//! workspace tools but never reach the frontend: the plugin host answers them.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::PluginHost;

const LIST: &str = "plugins.tools";
const CALL: &str = "plugins.call";

pub fn is_agent_method(method: &str) -> bool {
    method == LIST || method == CALL
}

pub fn execute(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    let host = app
        .try_state::<PluginHost>()
        .ok_or("plugins are not loaded")?;
    match method {
        LIST => Ok(list(&host)),
        CALL => {
            let name = params
                .get("tool")
                .and_then(Value::as_str)
                .ok_or("plugins.call needs the tool's name")?;
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            tauri::async_runtime::block_on(host.call_agent_tool(name, arguments))
                .map_err(|error| error.to_string())
        }
        _ => Err("unknown harness method".into()),
    }
}

fn list(host: &PluginHost) -> Value {
    Value::Array(
        host.agent_tools()
            .map(|(plugin, tool)| {
                json!({
                    "plugin": plugin,
                    "name": tool.name,
                    "method": tool.method,
                    "description": tool.description,
                    "properties": tool.properties,
                    "required": tool.required,
                })
            })
            .collect(),
    )
}
