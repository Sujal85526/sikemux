use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rayon::prelude::*;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};
use tokio::process::Command;

#[derive(Serialize, Deserialize)]
pub struct AgentSession {
    id: String,
    title: String,
    mtime: u64,
}

#[derive(Serialize)]
pub struct AgentInfo {
    #[serde(rename = "type")]
    kind: &'static str,
    label: &'static str,
    command: &'static str,
    #[serde(rename = "defaultModel")]
    default_model: Option<String>,
    #[serde(rename = "defaultEffort")]
    default_effort: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct AgentModelInfo {
    id: String,
    label: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(untagged)]
pub enum AgentUsageResetAt {
    Unix(u64),
    Iso(String),
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageWindow {
    label: String,
    used_percent: f64,
    resets_at: Option<AgentUsageResetAt>,
    window_minutes: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct AgentUsage {
    provider: &'static str,
    plan: Option<String>,
    windows: Vec<AgentUsageWindow>,
}

#[derive(Serialize, Clone)]
struct AgentSessionsChanged {
    agent: &'static str,
    cwd: String,
}

struct AgentDef {
    kind: &'static str,
    label: &'static str,
    command: &'static str,
}

const AGENT_DEFS: &[AgentDef] = &[
    AgentDef {
        kind: "claude",
        label: "Claude",
        command: "claude",
    },
    AgentDef {
        kind: "codex",
        label: "Codex",
        command: "codex",
    },
    AgentDef {
        kind: "hermes",
        label: "Hermes",
        command: "hermes",
    },
    AgentDef {
        kind: "pi",
        label: "Pi",
        command: "pi",
    },
    AgentDef {
        kind: "opencode",
        label: "OpenCode",
        command: "opencode",
    },
];

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Hermes,
    Pi,
    Opencode,
}

impl AgentKind {
    fn as_str(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Hermes => "hermes",
            AgentKind::Pi => "pi",
            AgentKind::Opencode => "opencode",
        }
    }
}

struct AgentWatchTarget {
    dir: PathBuf,
    mode: RecursiveMode,
}

struct AgentWatchHandle {
    _watchers: Vec<RecommendedWatcher>,
}

fn watch_registry() -> &'static Mutex<HashMap<u32, Arc<AgentWatchHandle>>> {
    static R: OnceLock<Mutex<HashMap<u32, Arc<AgentWatchHandle>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn watch_count() -> usize {
    watch_registry().lock().map(|r| r.len()).unwrap_or(0)
}

static NEXT_WATCH_ID: AtomicU32 = AtomicU32::new(1);

/// Agent CLIs that are installed for the current user. The app's PATH is fixed
/// from the login shell during boot, so this matches what spawned PTYs can run.
#[tauri::command]
pub fn available_agents() -> Vec<AgentInfo> {
    AGENT_DEFS
        .iter()
        .filter(|def| executable_in_path(def.kind, def.command))
        .map(|def| AgentInfo {
            kind: def.kind,
            label: def.label,
            command: def.command,
            default_model: configured_default_model(def.kind),
            default_effort: configured_default_effort(def.kind),
        })
        .collect()
}

/// Full model identifiers exposed by the selected CLI. Catalog lookup is lazy
/// because some providers build their list from local caches or provider data.
#[tauri::command]
pub async fn agent_models(agent: AgentKind) -> Result<Vec<AgentModelInfo>, String> {
    match agent {
        AgentKind::Claude => claude_models().await,
        AgentKind::Codex => run_model_catalog("codex", &["debug", "models", "--bundled"])
            .await
            .and_then(|text| {
                parse_codex_models(&text)
                    .ok_or_else(|| "Codex returned an unreadable model catalog".to_string())
            }),
        AgentKind::Hermes => hermes_cached_models(),
        AgentKind::Pi => run_model_catalog("pi", &["--list-models"])
            .await
            .map(|text| parse_pi_models(&text)),
        AgentKind::Opencode => run_model_catalog("opencode", &["models"])
            .await
            .map(|text| parse_line_models(&text)),
    }
}

/// Account-level plan usage for providers that expose structured rolling
/// windows. This intentionally goes through each installed CLI so Sikemux uses
/// the same account, credential store, and provider semantics as the agent.
#[tauri::command]
pub async fn agent_usage(agent: AgentKind) -> Result<AgentUsage, String> {
    match agent {
        AgentKind::Claude => claude_usage().await,
        AgentKind::Codex => codex_usage().await,
        _ => Err(format!(
            "{} does not expose structured plan usage",
            agent.as_str()
        )),
    }
}

const MODEL_CATALOG_TIMEOUT: Duration = Duration::from_secs(8);
const MODEL_CATALOG_OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const MODEL_CATALOG_ERROR_DETAIL_LIMIT: usize = 240;
const CLAUDE_MODEL_CATALOG_ARGS: &[&str] = &[
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--system-prompt",
    "",
    "--tools",
    "",
    "--input-format",
    "stream-json",
];

async fn run_model_catalog(agent: &str, args: &[&str]) -> Result<String, String> {
    run_model_catalog_with_input(agent, args, None).await
}

async fn run_model_catalog_with_input(
    agent: &str,
    args: &[&str],
    input: Option<&str>,
) -> Result<String, String> {
    let executable = crate::system::find_executable_matching(agent, |candidate| {
        allowed_agent_path(agent, candidate)
    })
    .ok_or_else(|| format!("{agent} is not available on PATH"))?;
    run_model_catalog_executable(agent, &executable, args, input).await
}

async fn run_model_catalog_executable(
    agent: &str,
    executable: &Path,
    args: &[&str],
    input: Option<&str>,
) -> Result<String, String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(if input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if agent == "claude" {
        command
            .env_remove("CLAUDECODE")
            .env("CLAUDE_CODE_ENTRYPOINT", "sikemux");
    }
    let mut child = command
        .spawn()
        .map_err(|_| format!("Could not start {agent} model lookup"))?;
    if let Some(input) = input {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("Could not open {agent} model lookup input"))?;
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|_| format!("Could not write {agent} model lookup input"))?;
        stdin
            .shutdown()
            .await
            .map_err(|_| format!("Could not finish {agent} model lookup input"))?;
    }
    let output = tokio::time::timeout(MODEL_CATALOG_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("{agent} model lookup timed out"))?
        .map_err(|_| format!("Could not read {agent} model lookup output"))?;
    if !output.status.success() {
        let detail = model_catalog_error_detail(&output.stderr);
        return Err(match detail {
            Some(detail) => format!("{agent} model lookup exited unsuccessfully: {detail}"),
            None => format!("{agent} model lookup exited unsuccessfully"),
        });
    }
    if output.stdout.len() > MODEL_CATALOG_OUTPUT_LIMIT {
        return Err(format!("{agent} model catalog was too large"));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| format!("{agent} model catalog was not valid UTF-8"))
}

fn model_catalog_error_detail(stderr: &[u8]) -> Option<String> {
    let normalized = String::from_utf8_lossy(stderr)
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        return None;
    }
    let mut characters = normalized.chars();
    let detail = characters
        .by_ref()
        .take(MODEL_CATALOG_ERROR_DETAIL_LIMIT)
        .collect::<String>();
    Some(if characters.next().is_some() {
        format!("{detail}…")
    } else {
        detail
    })
}

async fn claude_models() -> Result<Vec<AgentModelInfo>, String> {
    const REQUEST_ID: &str = "sikemux-models";
    let request = format!(
        "{{\"type\":\"control_request\",\"request_id\":\"{REQUEST_ID}\",\"request\":{{\"subtype\":\"initialize\",\"hooks\":null}}}}\n"
    );
    run_model_catalog_with_input("claude", CLAUDE_MODEL_CATALOG_ARGS, Some(&request))
        .await
        .and_then(|text| {
            let models = parse_claude_models(&text, REQUEST_ID);
            (!models.is_empty())
                .then_some(models)
                .ok_or_else(|| "Claude returned an empty model catalog".to_string())
        })
}

const CLAUDE_USAGE_REQUEST_ID: &str = "sikemux-usage";
const CODEX_USAGE_INITIALIZE_ID: u64 = 1;
const CODEX_USAGE_REQUEST_ID: u64 = 2;
const USAGE_LOOKUP_TIMEOUT: Duration = Duration::from_secs(12);
const USAGE_LOOKUP_OUTPUT_LIMIT: usize = 2 * 1024 * 1024;

async fn claude_usage() -> Result<AgentUsage, String> {
    let request = format!(
        "{{\"type\":\"control_request\",\"request_id\":\"{CLAUDE_USAGE_REQUEST_ID}\",\"request\":{{\"subtype\":\"get_usage\"}}}}\n"
    );
    run_model_catalog_with_input("claude", CLAUDE_MODEL_CATALOG_ARGS, Some(&request))
        .await
        .and_then(|text| {
            parse_claude_usage(&text, CLAUDE_USAGE_REQUEST_ID)
                .ok_or_else(|| "Claude returned an unreadable usage snapshot".to_string())
        })
}

async fn codex_usage() -> Result<AgentUsage, String> {
    let executable = crate::system::find_executable_matching("codex", |candidate| {
        allowed_agent_path("codex", candidate)
    })
    .ok_or_else(|| "codex is not available on PATH".to_string())?;
    run_codex_usage_executable(&executable).await
}

async fn run_codex_usage_executable(executable: &Path) -> Result<AgentUsage, String> {
    let mut child = Command::new(executable)
        .args(["app-server", "--stdio"])
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "Could not start Codex usage lookup".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not open Codex usage lookup input".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read Codex usage lookup output".to_string())?;
    let mut lines = AsyncBufReader::new(stdout).lines();

    let lookup = tokio::time::timeout(USAGE_LOOKUP_TIMEOUT, async {
        let initialize = serde_json::json!({
            "id": CODEX_USAGE_INITIALIZE_ID,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "sikemux",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": { "experimentalApi": true },
            },
        });
        stdin
            .write_all(format!("{initialize}\n").as_bytes())
            .await
            .map_err(|_| "Could not initialize Codex usage lookup".to_string())?;
        stdin
            .flush()
            .await
            .map_err(|_| "Could not initialize Codex usage lookup".to_string())?;

        let mut output_bytes = 0usize;
        let mut initialized = false;
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|_| "Could not read Codex usage lookup output".to_string())?
        {
            output_bytes = output_bytes.saturating_add(line.len());
            if output_bytes > USAGE_LOOKUP_OUTPUT_LIMIT {
                return Err("Codex usage lookup output was too large".to_string());
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let response_id = value.get("id").and_then(Value::as_u64);
            if response_id == Some(CODEX_USAGE_INITIALIZE_ID) && !initialized {
                if value.get("error").is_some() {
                    return Err("Codex rejected usage lookup initialization".to_string());
                }
                let requests = format!(
                    "{{\"method\":\"initialized\"}}\n{{\"id\":{CODEX_USAGE_REQUEST_ID},\"method\":\"account/rateLimits/read\",\"params\":null}}\n"
                );
                stdin
                    .write_all(requests.as_bytes())
                    .await
                    .map_err(|_| "Could not request Codex usage".to_string())?;
                stdin
                    .flush()
                    .await
                    .map_err(|_| "Could not request Codex usage".to_string())?;
                initialized = true;
                continue;
            }
            if response_id != Some(CODEX_USAGE_REQUEST_ID) {
                continue;
            }
            if value.get("error").is_some() {
                return Err("Codex rejected the usage lookup".to_string());
            }
            let result = value
                .get("result")
                .ok_or_else(|| "Codex returned an empty usage snapshot".to_string())?;
            return Ok(parse_codex_usage_result(result));
        }
        Err("Codex usage lookup closed before responding".to_string())
    })
    .await;

    drop(stdin);
    let _ = child.kill().await;
    let _ = child.wait().await;

    lookup.map_err(|_| "Codex usage lookup timed out".to_string())?
}

fn usage_reset_at(value: &Value) -> Option<AgentUsageResetAt> {
    value.as_u64().map(AgentUsageResetAt::Unix).or_else(|| {
        value
            .as_str()
            .map(|value| AgentUsageResetAt::Iso(value.to_string()))
    })
}

fn push_claude_usage_window(
    windows: &mut Vec<AgentUsageWindow>,
    limits: &Value,
    key: &str,
    label: &str,
    window_minutes: u64,
) {
    let Some(window) = limits.get(key) else {
        return;
    };
    let Some(used_percent) = window.get("utilization").and_then(Value::as_f64) else {
        return;
    };
    windows.push(AgentUsageWindow {
        label: label.to_string(),
        used_percent: used_percent.clamp(0.0, 100.0),
        resets_at: window.get("resets_at").and_then(usage_reset_at),
        window_minutes: Some(window_minutes),
    });
}

fn parse_claude_usage(text: &str, request_id: &str) -> Option<AgentUsage> {
    let payload = text.lines().find_map(|line| {
        let value: Value = serde_json::from_str(line).ok()?;
        let response = value.get("response")?;
        if value.get("type").and_then(Value::as_str) != Some("control_response")
            || response.get("request_id").and_then(Value::as_str) != Some(request_id)
            || response.get("subtype").and_then(Value::as_str) != Some("success")
        {
            return None;
        }
        response.get("response").cloned()
    })?;

    let plan = payload
        .get("subscription_type")
        .and_then(Value::as_str)
        .and_then(clean_model);
    let mut windows = Vec::new();
    if let Some(limits) = payload.get("rate_limits").filter(|value| value.is_object()) {
        push_claude_usage_window(&mut windows, limits, "five_hour", "5h", 300);
        push_claude_usage_window(&mut windows, limits, "seven_day", "7d", 10_080);
        push_claude_usage_window(&mut windows, limits, "seven_day_opus", "Opus · 7d", 10_080);
        push_claude_usage_window(
            &mut windows,
            limits,
            "seven_day_sonnet",
            "Sonnet · 7d",
            10_080,
        );
        push_claude_usage_window(
            &mut windows,
            limits,
            "seven_day_oauth_apps",
            "OAuth apps · 7d",
            10_080,
        );
        if let Some(model_scoped) = limits.get("model_scoped").and_then(Value::as_array) {
            for window in model_scoped {
                let Some(display_name) = window
                    .get("display_name")
                    .and_then(Value::as_str)
                    .and_then(clean_model)
                else {
                    continue;
                };
                let Some(used_percent) = window.get("utilization").and_then(Value::as_f64) else {
                    continue;
                };
                windows.push(AgentUsageWindow {
                    label: format!("{display_name} · 7d"),
                    used_percent: used_percent.clamp(0.0, 100.0),
                    resets_at: window.get("resets_at").and_then(usage_reset_at),
                    window_minutes: Some(10_080),
                });
            }
        }
    }

    Some(AgentUsage {
        provider: "claude",
        plan,
        windows,
    })
}

fn usage_duration_label(minutes: Option<u64>, fallback: &str) -> String {
    match minutes {
        Some(300) => "5h".to_string(),
        Some(10_080) => "7d".to_string(),
        Some(minutes) if minutes >= 1_440 && minutes % 1_440 == 0 => {
            format!("{}d", minutes / 1_440)
        }
        Some(minutes) if minutes >= 60 && minutes % 60 == 0 => {
            format!("{}h", minutes / 60)
        }
        Some(minutes) => format!("{minutes}m"),
        None => fallback.to_string(),
    }
}

fn push_codex_usage_window(
    windows: &mut Vec<AgentUsageWindow>,
    snapshot: &Value,
    key: &str,
    fallback: &str,
    scope: Option<&str>,
) {
    let Some(window) = snapshot.get(key).filter(|value| value.is_object()) else {
        return;
    };
    let Some(used_percent) = window.get("usedPercent").and_then(Value::as_f64) else {
        return;
    };
    let window_minutes = window.get("windowDurationMins").and_then(Value::as_u64);
    let duration = usage_duration_label(window_minutes, fallback);
    windows.push(AgentUsageWindow {
        label: scope
            .map(|scope| format!("{scope} · {duration}"))
            .unwrap_or(duration),
        used_percent: used_percent.clamp(0.0, 100.0),
        resets_at: window.get("resetsAt").and_then(usage_reset_at),
        window_minutes,
    });
}

fn parse_codex_usage_result(result: &Value) -> AgentUsage {
    let mut snapshots: Vec<(&str, &Value)> = result
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .map(|values| {
            let mut rows = values
                .iter()
                .map(|(key, value)| (key.as_str(), value))
                .collect::<Vec<_>>();
            rows.sort_by(|(left, _), (right, _)| {
                (left != &"codex", *left).cmp(&(right != &"codex", *right))
            });
            rows
        })
        .unwrap_or_default();
    if snapshots.is_empty() {
        if let Some(snapshot) = result.get("rateLimits").filter(|value| value.is_object()) {
            snapshots.push(("codex", snapshot));
        }
    }

    let plan = snapshots.iter().find_map(|(_, snapshot)| {
        snapshot
            .get("planType")
            .and_then(Value::as_str)
            .and_then(clean_model)
    });
    let mut windows = Vec::new();
    for (key, snapshot) in snapshots {
        let limit_id = snapshot
            .get("limitId")
            .and_then(Value::as_str)
            .unwrap_or(key);
        let scope = (limit_id != "codex")
            .then(|| snapshot.get("limitName").and_then(Value::as_str))
            .flatten()
            .and_then(clean_model);
        push_codex_usage_window(
            &mut windows,
            snapshot,
            "primary",
            "Primary",
            scope.as_deref(),
        );
        push_codex_usage_window(
            &mut windows,
            snapshot,
            "secondary",
            "Secondary",
            scope.as_deref(),
        );
    }

    AgentUsage {
        provider: "codex",
        plan,
        windows,
    }
}

fn parse_claude_models(text: &str, request_id: &str) -> Vec<AgentModelInfo> {
    let Some(models) = text.lines().find_map(|line| {
        let value: Value = serde_json::from_str(line).ok()?;
        let response = value.get("response")?;
        if value.get("type").and_then(Value::as_str) != Some("control_response")
            || response.get("request_id").and_then(Value::as_str) != Some(request_id)
        {
            return None;
        }
        response.get("response")?.get("models")?.as_array().cloned()
    }) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    models
        .iter()
        // "default" is the inherited selection already rendered first by the UI.
        .filter(|model| model.get("value").and_then(Value::as_str) != Some("default"))
        .filter_map(|model| {
            let id = model.get("resolvedModel")?.as_str()?;
            let info = model_info(id, model.get("displayName").and_then(Value::as_str))?;
            seen.insert(info.id.clone()).then_some(info)
        })
        .collect()
}

fn parse_codex_models(text: &str) -> Option<Vec<AgentModelInfo>> {
    let value: Value = serde_json::from_str(text).ok()?;
    let models = value.get("models")?.as_array()?;
    Some(
        models
            .iter()
            .filter(|model| model.get("visibility").and_then(Value::as_str) == Some("list"))
            .filter_map(|model| {
                model_info(
                    model.get("slug")?.as_str()?,
                    model.get("display_name").and_then(Value::as_str),
                )
            })
            .collect(),
    )
}

fn parse_pi_models(text: &str) -> Vec<AgentModelInfo> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let provider = columns.next()?;
            let model = columns.next()?;
            model_info(&format!("{provider}/{model}"), None)
        })
        .collect()
}

fn parse_line_models(text: &str) -> Vec<AgentModelInfo> {
    text.lines()
        .filter_map(|line| model_info(line, None))
        .collect()
}

fn hermes_cached_models() -> Result<Vec<AgentModelInfo>, String> {
    let Some(home) = home_path() else {
        return Ok(Vec::new());
    };
    let Ok(config) = fs::read_to_string(home.join(".hermes/config.yaml")) else {
        return Ok(Vec::new());
    };
    let (provider, _) = yaml_model_section(&config);
    let Some(provider) = provider else {
        return Ok(Vec::new());
    };
    let Ok(text) = fs::read_to_string(home.join(".hermes/provider_models_cache.json")) else {
        return Ok(Vec::new());
    };
    Ok(parse_hermes_models(&text, &provider).unwrap_or_default())
}

fn parse_hermes_models(text: &str, provider: &str) -> Option<Vec<AgentModelInfo>> {
    let value: Value = serde_json::from_str(text).ok()?;
    Some(
        value
            .get(provider)?
            .get("models")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .filter_map(|model| model_info(&format!("{provider}/{model}"), None))
            .collect(),
    )
}

fn model_info(id: &str, label: Option<&str>) -> Option<AgentModelInfo> {
    let id = clean_model(id)?;
    let label = label.and_then(clean_model).unwrap_or_else(|| id.clone());
    Some(AgentModelInfo { id, label })
}

const MAX_MODEL_LENGTH: usize = 256;

fn configured_default_model(kind: &str) -> Option<String> {
    let home = home_path()?;
    match kind {
        "claude" => std::env::var("ANTHROPIC_MODEL")
            .ok()
            .and_then(|value| clean_model(&value))
            .or_else(|| json_model(&home.join(".claude/settings.local.json"), "model"))
            .or_else(|| json_model(&home.join(".claude/settings.json"), "model")),
        "codex" => {
            let root = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"));
            fs::read_to_string(root.join("config.toml"))
                .ok()
                .and_then(|text| toml_model(&text))
        }
        "hermes" => std::env::var("HERMES_INFERENCE_MODEL")
            .ok()
            .and_then(|value| clean_model(&value))
            .or_else(|| {
                let text = fs::read_to_string(home.join(".hermes/config.yaml")).ok()?;
                let (provider, model) = yaml_model_section(&text);
                qualify_model(provider.as_deref(), model.as_deref())
            }),
        "pi" => {
            let root = std::env::var_os("PI_CODING_AGENT_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".pi/agent"));
            let value: Value =
                serde_json::from_str(&fs::read_to_string(root.join("settings.json")).ok()?).ok()?;
            qualify_model(
                value.get("defaultProvider").and_then(Value::as_str),
                value.get("defaultModel").and_then(Value::as_str),
            )
        }
        "opencode" => {
            let path = std::env::var_os("OPENCODE_CONFIG")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    let config = std::env::var_os("XDG_CONFIG_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".config"));
                    config.join("opencode/opencode.json")
                });
            json_model(&path, "model")
        }
        _ => None,
    }
}

fn configured_default_effort(kind: &str) -> Option<String> {
    let home = home_path()?;
    match kind {
        "claude" => json_effort(
            &home.join(".claude/settings.local.json"),
            "effortLevel",
            kind,
        )
        .or_else(|| json_effort(&home.join(".claude/settings.json"), "effortLevel", kind)),
        "codex" => {
            let root = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"));
            fs::read_to_string(root.join("config.toml"))
                .ok()
                .and_then(|text| toml_effort(&text))
        }
        "hermes" => fs::read_to_string(home.join(".hermes/config.yaml"))
            .ok()
            .and_then(|text| yaml_agent_reasoning_effort(&text))
            .and_then(|value| clean_effort(kind, &value)),
        "pi" => {
            let root = std::env::var_os("PI_CODING_AGENT_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".pi/agent"));
            json_effort(&root.join("settings.json"), "defaultThinkingLevel", kind)
        }
        _ => None,
    }
}

fn clean_model(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.chars().count() <= MAX_MODEL_LENGTH).then(|| value.to_string())
}

fn clean_effort(kind: &str, value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    let allowed: &[&str] = match kind {
        "claude" => &["low", "medium", "high", "xhigh", "max"],
        "codex" => &["minimal", "low", "medium", "high", "xhigh", "max"],
        "hermes" => &[
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ],
        "pi" => &["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        _ => &[],
    };
    allowed.contains(&value.as_str()).then_some(value)
}

fn json_model(path: &Path, key: &str) -> Option<String> {
    let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    value.get(key).and_then(Value::as_str).and_then(clean_model)
}

fn json_effort(path: &Path, key: &str, kind: &str) -> Option<String> {
    let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    value
        .get(key)
        .and_then(Value::as_str)
        .and_then(|value| clean_effort(kind, value))
}

fn qualify_model(provider: Option<&str>, model: Option<&str>) -> Option<String> {
    let model = clean_model(model?)?;
    if model.contains('/') {
        return Some(model);
    }
    let provider = provider.and_then(clean_model);
    provider
        .and_then(|provider| clean_model(&format!("{provider}/{model}")))
        .or(Some(model))
}

fn toml_model(text: &str) -> Option<String> {
    let value: toml::Value = toml::from_str(text).ok()?;
    value
        .get("model")
        .and_then(toml::Value::as_str)
        .and_then(clean_model)
}

fn toml_effort(text: &str) -> Option<String> {
    let value: toml::Value = toml::from_str(text).ok()?;
    value
        .get("model_reasoning_effort")
        .and_then(toml::Value::as_str)
        .and_then(|value| clean_effort("codex", value))
}

/// Extract only `provider` and `default` from Hermes' top-level `model` map.
/// This deliberately avoids deserializing or exposing the rest of config.yaml.
fn yaml_model_section(text: &str) -> (Option<String>, Option<String>) {
    let mut model_indent = None;
    let mut provider = None;
    let mut model = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let Some(section_indent) = model_indent else {
            if trimmed == "model:" {
                model_indent = Some(indent);
            }
            continue;
        };
        if indent <= section_indent {
            break;
        }
        if trimmed.ends_with(':') {
            continue;
        }
        let Some((key, raw)) = trimmed.split_once(':') else {
            continue;
        };
        let value = yaml_scalar(raw);
        match key.trim() {
            "provider" => provider = value,
            "default" => model = value,
            _ => {}
        }
    }
    (provider, model)
}

fn yaml_agent_reasoning_effort(text: &str) -> Option<String> {
    let mut agent_indent = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let Some(section_indent) = agent_indent else {
            if trimmed == "agent:" {
                agent_indent = Some(indent);
            }
            continue;
        };
        if indent <= section_indent {
            break;
        }
        let Some((key, raw)) = trimmed.split_once(':') else {
            continue;
        };
        if key.trim() == "reasoning_effort" {
            return yaml_scalar(raw);
        }
    }
    None
}

fn yaml_scalar(raw: &str) -> Option<String> {
    let raw = raw.split(" #").next()?.trim();
    let raw = if raw.len() >= 2
        && ((raw.starts_with('"') && raw.ends_with('"'))
            || (raw.starts_with('\'') && raw.ends_with('\'')))
    {
        &raw[1..raw.len() - 1]
    } else {
        raw
    };
    clean_model(raw)
}

/// Existing on-disk conversations for an agent.
#[tauri::command]
pub fn agent_sessions(agent: AgentKind, cwd: String) -> Vec<AgentSession> {
    match agent {
        AgentKind::Claude => claude_sessions(&cwd),
        AgentKind::Codex => codex_sessions(&cwd),
        AgentKind::Hermes => hermes_sessions(),
        AgentKind::Pi => pi_sessions(&cwd),
        AgentKind::Opencode => opencode_sessions(&cwd),
    }
}

const AGENT_DEBOUNCE_MS: u64 = 200;

fn home_path() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

fn push_watch_target(out: &mut Vec<AgentWatchTarget>, dir: PathBuf, mode: RecursiveMode) {
    if !dir.is_dir() {
        return;
    }
    if let Some(existing) = out.iter_mut().find(|target| target.dir == dir) {
        if matches!(mode, RecursiveMode::Recursive) {
            existing.mode = RecursiveMode::Recursive;
        }
        return;
    }
    out.push(AgentWatchTarget { dir, mode });
}

fn push_existing_or_parent(
    out: &mut Vec<AgentWatchTarget>,
    path: PathBuf,
    existing_mode: RecursiveMode,
) {
    if path.is_dir() {
        push_watch_target(out, path, existing_mode);
    } else if let Some(parent) = path.parent() {
        push_watch_target(out, parent.to_path_buf(), RecursiveMode::NonRecursive);
    }
}

fn agent_watch_dirs(agent: AgentKind, cwd: &str) -> Vec<AgentWatchTarget> {
    let mut out = Vec::new();
    match agent {
        AgentKind::Claude => {
            if let Some(home) = home_path() {
                let projects = home.join(".claude/projects");
                let project = projects.join(cwd.replace('/', "-"));
                if project.is_dir() {
                    push_watch_target(&mut out, project, RecursiveMode::Recursive);
                } else {
                    push_watch_target(&mut out, projects, RecursiveMode::NonRecursive);
                }
            }
        }
        AgentKind::Codex => {
            if let Some(home) = home_path() {
                let codex = home.join(".codex");
                let sessions = codex.join("sessions");
                if sessions.is_dir() {
                    push_watch_target(&mut out, sessions, RecursiveMode::Recursive);
                } else {
                    push_watch_target(&mut out, codex, RecursiveMode::NonRecursive);
                }
            }
        }
        AgentKind::Hermes => {
            if let Some(home) = home_path() {
                push_watch_target(&mut out, home.join(".hermes"), RecursiveMode::NonRecursive);
            }
        }
        AgentKind::Pi => {
            if let Some(root) = pi_session_dir() {
                push_existing_or_parent(&mut out, root, RecursiveMode::Recursive);
            }
        }
        AgentKind::Opencode => {
            for dir in opencode_data_dirs() {
                push_existing_or_parent(&mut out, dir, RecursiveMode::NonRecursive);
            }
        }
    }
    out
}

fn agent_event_interesting(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn spawn_agent_debouncer(
    app: AppHandle,
    agent: &'static str,
    cwd: String,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    tauri::async_runtime::spawn(async move {
        while rx.recv().await.is_some() {
            let sleep = tokio::time::sleep(Duration::from_millis(AGENT_DEBOUNCE_MS));
            tokio::pin!(sleep);
            let mut closed = false;
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    msg = rx.recv() => {
                        if msg.is_none() {
                            closed = true;
                            break;
                        }
                        sleep
                            .as_mut()
                            .reset(tokio::time::Instant::now() + Duration::from_millis(AGENT_DEBOUNCE_MS));
                    }
                }
            }
            if closed {
                return;
            }
            let _ = app.emit(
                "agent_sessions_changed",
                AgentSessionsChanged {
                    agent,
                    cwd: cwd.clone(),
                },
            );
        }
    });
}

#[tauri::command]
pub fn agent_sessions_watch_start(
    app: AppHandle,
    agent: AgentKind,
    cwd: String,
) -> Result<u32, String> {
    let dirs = agent_watch_dirs(agent, &cwd);
    let id = NEXT_WATCH_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    spawn_agent_debouncer(app, agent.as_str(), cwd, rx);

    let mut watchers = Vec::new();
    for target in dirs {
        let tx_events = tx.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(event) = res else { return };
            if !agent_event_interesting(&event) {
                return;
            }
            let _ = tx_events.send(());
        })
        .map_err(|e| e.to_string())?;
        if watcher.watch(&target.dir, target.mode).is_ok() {
            watchers.push(watcher);
        }
    }

    watch_registry().lock().map_err(|e| e.to_string())?.insert(
        id,
        Arc::new(AgentWatchHandle {
            _watchers: watchers,
        }),
    );
    Ok(id)
}

#[tauri::command]
pub fn agent_sessions_watch_stop(id: u32) -> Result<(), String> {
    watch_registry()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    Ok(())
}

fn executable_in_path(agent: &str, bin: &str) -> bool {
    crate::system::find_executable_matching(bin, |candidate| allowed_agent_path(agent, candidate))
        .is_some()
}

fn allowed_agent_path(agent: &str, path: &Path) -> bool {
    if agent != "opencode" {
        return true;
    }
    let Ok(home) = std::env::var("HOME") else {
        return true;
    };
    allowed_agent_path_for_home(agent, path, Path::new(&home))
}

fn allowed_agent_path_for_home(agent: &str, path: &Path, home: &Path) -> bool {
    if agent != "opencode" {
        return true;
    }
    // OpenCode leaves a runnable self-contained binary under ~/.opencode/bin.
    // Treat that as app data/cache rather than a user-visible system install;
    // otherwise stale copies keep showing up in the agent rail after uninstall.
    path.parent() != Some(home.join(".opencode").join("bin").as_path())
}

fn mtime_of(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct TitleCacheStamp {
    modified_ns: u128,
    len: u64,
}

fn title_cache_stamp(path: &Path) -> TitleCacheStamp {
    let metadata = fs::metadata(path).ok();
    TitleCacheStamp {
        modified_ns: metadata
            .as_ref()
            .and_then(|value| value.modified().ok())
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos())
            .unwrap_or(0),
        len: metadata.map(|value| value.len()).unwrap_or(0),
    }
}

fn condense(text: &str) -> Option<String> {
    let c = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if c.is_empty() || c.starts_with('<') {
        return None;
    }
    Some(c.chars().take(72).collect())
}

fn text_from_content(content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    content.as_array()?.iter().find_map(|b| {
        if b.get("type").and_then(|t| t.as_str()) == Some("text") {
            b.get("text").and_then(|t| t.as_str()).map(String::from)
        } else {
            None
        }
    })
}

/// Cached title per transcript: `path -> (high-resolution stamp, title)`.
type TitleCache = HashMap<PathBuf, (TitleCacheStamp, Option<String>, u64)>;
const MAX_TITLE_CACHE_ENTRIES: usize = 2_048;
const MAX_AGENT_TRANSCRIPT_PATHS: usize = 20_000;
const MAX_AGENT_TRANSCRIPTS_INSPECTED: usize = 5_000;

fn next_title_cache_access() -> u64 {
    static ACCESS: AtomicU64 = AtomicU64::new(1);
    ACCESS.fetch_add(1, Ordering::Relaxed)
}

/// Per-file title cache keyed by a high-resolution file stamp. Titles are derived from transcript
/// content that only ever grows, so an unchanged nanosecond timestamp and file
/// length means an unchanged title. Length prevents same-tick appends from
/// preserving a cached title-less result on coarse filesystems.
/// This turns the palette's cold scan of every session into a one-time cost:
/// reopening it re-reads only the sessions that have actually changed.
fn title_cache() -> &'static Mutex<TitleCache> {
    static CACHE: OnceLock<Mutex<TitleCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Return the cached title for `path` when its stamp matches, otherwise run
/// `compute`, store the result (including `None`, so title-less files are not
/// re-scanned), and return it.
fn cached_title<F>(path: &Path, stamp: TitleCacheStamp, compute: F) -> Option<String>
where
    F: FnOnce() -> Option<String>,
{
    if let Ok(mut cache) = title_cache().lock() {
        if let Some((cached_stamp, title, access)) = cache.get_mut(path) {
            if *cached_stamp == stamp {
                *access = next_title_cache_access();
                return title.clone();
            }
        }
    }
    let title = compute();
    if let Ok(mut cache) = title_cache().lock() {
        if cache.len() >= MAX_TITLE_CACHE_ENTRIES && !cache.contains_key(path) {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (_, _, access))| *access)
                .map(|(path, _)| path.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(
            path.to_path_buf(),
            (stamp, title.clone(), next_title_cache_access()),
        );
    }
    title
}

/// Read up to `n` bytes from the start of `file` as lossy UTF-8.
fn read_prefix(file: &mut fs::File, n: u64) -> Option<String> {
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut buf = Vec::new();
    file.by_ref().take(n).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Read from `start` to the end of `file` as lossy UTF-8.
fn read_suffix(file: &mut fs::File, start: u64) -> Option<String> {
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

// ---- claude — ~/.claude/projects/<cwd-dashed>/<uuid>.jsonl --------------
fn claude_sessions(cwd: &str) -> Vec<AgentSession> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    let dir = PathBuf::from(&home)
        .join(".claude/projects")
        .join(cwd.replace('/', "-"));
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect();
    paths.sort_unstable_by_key(|path| std::cmp::Reverse(mtime_of(path)));
    paths.truncate(MAX_AGENT_TRANSCRIPTS_INSPECTED);
    // Titles come from reading each transcript, so fan the per-file work out
    // across rayon's pool instead of scanning sessions one at a time.
    let mut out: Vec<AgentSession> = paths
        .par_iter()
        .filter_map(|path| {
            let id = path.file_stem().and_then(|s| s.to_str())?;
            let mtime = mtime_of(path);
            let title = cached_title(path, title_cache_stamp(path), || claude_title(path))
                .unwrap_or_else(|| id.chars().take(8).collect());
            Some(AgentSession {
                id: id.to_string(),
                title,
                mtime,
            })
        })
        .collect();
    out.sort_by_key(|item| std::cmp::Reverse(item.mtime));
    out
}

/// Pull a title out of one Claude transcript line, updating the running
/// `ai_title` (last write wins) and `first_user` (first write wins).
fn scan_claude_line(line: &str, ai_title: &mut Option<String>, first_user: &mut Option<String>) {
    if line.contains("\"type\":\"ai-title\"") {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()).and_then(condense) {
                *ai_title = Some(t);
            }
        }
    } else if first_user.is_none() && line.contains("\"type\":\"user\"") {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if v.get("type").and_then(|t| t.as_str()) == Some("user") {
                *first_user = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(text_from_content)
                    .and_then(|text| condense(&text));
            }
        }
    }
}

// Bound the per-file read: the first user prompt sits near the top and Claude
// emits `ai-title` entries continuously (so the freshest title sits at the end),
// which lets us skip the middle of multi-MB transcripts.
const CLAUDE_HEAD_BYTES: u64 = 128 * 1024;
const CLAUDE_TAIL_BYTES: u64 = 128 * 1024;

fn claude_title(path: &Path) -> Option<String> {
    // Claude writes the human-readable title (auto-generated, then overwritten by
    // `/rename`) as `{"type":"ai-title","aiTitle":...}` entries appended as the
    // session grows — last one wins. This is what Claude's own /resume picker
    // shows. Prefer it; fall back to the first user prompt for sessions that have
    // no title yet. Cheap substring guards keep us from JSON-parsing every line.
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();

    let mut ai_title: Option<String> = None;
    let mut first_user: Option<String> = None;

    // Head: captures the first user prompt and any early ai-title. For small
    // transcripts this covers the whole file, keeping the result exact.
    let head = read_prefix(&mut file, CLAUDE_HEAD_BYTES.min(len))?;
    for line in head.lines() {
        scan_claude_line(line, &mut ai_title, &mut first_user);
    }

    // Tail: the most recent ai-title lives at the end of large transcripts. Skip
    // the first (likely partial) line, then take the last ai-title we can parse.
    if len > CLAUDE_HEAD_BYTES {
        if let Some(tail) = read_suffix(&mut file, len.saturating_sub(CLAUDE_TAIL_BYTES)) {
            for line in tail.lines().skip(1) {
                if line.contains("\"type\":\"ai-title\"") {
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        if let Some(t) =
                            v.get("aiTitle").and_then(|t| t.as_str()).and_then(condense)
                        {
                            ai_title = Some(t);
                        }
                    }
                }
            }
        }
    }

    ai_title.or(first_user)
}

// ---- codex — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ----------------
fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 6 || out.len() >= MAX_AGENT_TRANSCRIPT_PATHS {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_AGENT_TRANSCRIPT_PATHS {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out, depth + 1);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn codex_sessions(cwd: &str) -> Vec<AgentSession> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    let mut files = Vec::new();
    collect_jsonl(&PathBuf::from(&home).join(".codex/sessions"), &mut files, 0);
    files.sort_unstable_by_key(|path| std::cmp::Reverse(mtime_of(path)));
    files.truncate(MAX_AGENT_TRANSCRIPTS_INSPECTED);

    let mut out: Vec<AgentSession> = files
        .par_iter()
        .filter_map(|path| {
            let file = fs::File::open(path).ok()?;
            let mut first = String::new();
            BufReader::new(file).read_line(&mut first).ok()?;
            let v = serde_json::from_str::<Value>(first.trim()).ok()?;
            if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
                return None;
            }
            let payload = v.get("payload")?;
            if payload.get("cwd").and_then(|c| c.as_str()) != Some(cwd) {
                return None;
            }
            let id = payload.get("id").and_then(|i| i.as_str())?;
            let mtime = mtime_of(path);
            let title = cached_title(path, title_cache_stamp(path), || codex_title(path))
                .unwrap_or_else(|| id.chars().take(8).collect());
            Some(AgentSession {
                id: id.to_string(),
                title,
                mtime,
            })
        })
        .collect();
    out.sort_by_key(|item| std::cmp::Reverse(item.mtime));
    out
}

fn codex_title(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(200).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
            continue;
        }
        let payload = v.get("payload");
        if payload.and_then(|p| p.get("type")).and_then(|t| t.as_str()) != Some("user_message") {
            continue;
        }
        let msg = payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("");
        if let Some(t) = condense(msg) {
            return Some(t);
        }
    }
    None
}

// ---- pi — ~/.pi/agent/sessions/**/<session>.jsonl ----------------------
fn pi_session_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_SESSION_DIR") {
        return Some(PathBuf::from(dir));
    }
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        return Some(PathBuf::from(dir).join("sessions"));
    }
    std::env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(".pi/agent/sessions"))
}

fn pi_sessions(cwd: &str) -> Vec<AgentSession> {
    let Some(root) = pi_session_dir() else {
        return Vec::new();
    };
    let mut files = Vec::new();
    collect_jsonl(&root, &mut files, 0);
    files.sort_unstable_by_key(|path| std::cmp::Reverse(mtime_of(path)));
    files.truncate(MAX_AGENT_TRANSCRIPTS_INSPECTED);

    let mut out: Vec<AgentSession> = files
        .par_iter()
        .filter_map(|path| {
            let file = fs::File::open(path).ok()?;
            let mut first = String::new();
            BufReader::new(file).read_line(&mut first).ok()?;
            let v = serde_json::from_str::<Value>(first.trim()).ok()?;
            if v.get("type").and_then(|t| t.as_str()) != Some("session") {
                return None;
            }
            if v.get("cwd").and_then(|c| c.as_str()) != Some(cwd) {
                return None;
            }
            let id = path.to_string_lossy().to_string();
            let mtime = mtime_of(path);
            let title = cached_title(path, title_cache_stamp(path), || pi_title(path))
                .or_else(|| v.get("id").and_then(|i| i.as_str()).and_then(condense))
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("session")
                        .chars()
                        .take(13)
                        .collect()
                });
            Some(AgentSession { id, title, mtime })
        })
        .collect();
    out.sort_by_key(|item| std::cmp::Reverse(item.mtime));
    out
}

fn pi_title(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut first_user: Option<String> = None;
    let mut named: Option<String> = None;
    for line in BufReader::new(file).lines().take(220).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session_info") => {
                if let Some(name) = v.get("name").and_then(|n| n.as_str()).and_then(condense) {
                    named = Some(name);
                }
            }
            Some("message") if first_user.is_none() => {
                let Some(message) = v.get("message") else {
                    continue;
                };
                if message.get("role").and_then(|r| r.as_str()) != Some("user") {
                    continue;
                }
                if let Some(text) = message
                    .get("content")
                    .and_then(text_from_content)
                    .and_then(|t| condense(&t))
                {
                    first_user = Some(text);
                }
            }
            _ => {}
        }
    }
    named.or(first_user)
}

// ---- hermes — `sessions` table in ~/.hermes/state.db (SQLite) -----------
fn hermes_sessions() -> Vec<AgentSession> {
    let Ok(home) = std::env::var("HOME") else {
        return Vec::new();
    };
    let db = PathBuf::from(&home).join(".hermes/state.db");
    if !db.exists() {
        return Vec::new();
    }

    let conn = match Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut stmt = match conn.prepare(
        "SELECT id, \
         COALESCE(NULLIF(TRIM(title), ''), substr(id, 1, 13)) AS title, \
         CAST(COALESCE(started_at, 0) AS INTEGER) AS mtime \
         FROM sessions ORDER BY started_at DESC LIMIT 400",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |row| {
        Ok(AgentSession {
            id: row.get::<_, String>(0)?,
            title: row.get::<_, String>(1)?,
            mtime: row.get::<_, i64>(2).unwrap_or(0) as u64,
        })
    });
    match rows {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

// ---- opencode — SQLite in the user's opencode data dir ------------------
fn opencode_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("OPENCODE_DATA_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(&home).join(".local/share/opencode"));
        dirs.push(PathBuf::from(&home).join("Library/Application Support/opencode"));
        dirs.push(PathBuf::from(&home).join(".opencode/data"));
    }
    dirs
}

fn opencode_db_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for dir in opencode_data_dirs() {
        let direct = dir.join("opencode.db");
        if direct.exists() {
            paths.push(direct);
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if name.starts_with("opencode")
                && name.ends_with(".db")
                && !paths.iter().any(|p| p == &path)
            {
                paths.push(path);
            }
        }
    }
    paths
}

fn normalize_unix_secs(raw: u64) -> u64 {
    if raw > 10_000_000_000 {
        raw / 1000
    } else {
        raw
    }
}

fn opencode_sessions(cwd: &str) -> Vec<AgentSession> {
    let mut out = Vec::new();
    for db in opencode_db_paths() {
        let Ok(conn) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
            continue;
        };
        out.extend(opencode_sessions_from_conn(&conn, cwd));
    }
    out.sort_by_key(|item| std::cmp::Reverse(item.mtime));
    let mut seen = HashSet::new();
    out.retain(|s| seen.insert(s.id.clone()));
    out.truncate(400);
    out
}

fn opencode_sessions_from_conn(conn: &Connection, cwd: &str) -> Vec<AgentSession> {
    let with_project = "\
        SELECT s.id, \
               COALESCE(NULLIF(TRIM(s.title), ''), NULLIF(TRIM(s.slug), ''), substr(s.id, 1, 13)) AS title, \
               CAST(COALESCE(s.time_updated, s.time_created, 0) AS INTEGER) AS mtime \
        FROM session s \
        LEFT JOIN project p ON p.id = s.project_id \
        WHERE s.directory = ?1 OR s.path = ?1 OR p.worktree = ?1 \
        ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC \
        LIMIT 400";
    if let Some(rows) = opencode_query(conn, with_project, cwd) {
        return rows;
    }

    let session_only = "\
        SELECT id, \
               COALESCE(NULLIF(TRIM(title), ''), NULLIF(TRIM(slug), ''), substr(id, 1, 13)) AS title, \
               CAST(COALESCE(time_updated, time_created, 0) AS INTEGER) AS mtime \
        FROM session \
        WHERE directory = ?1 OR path = ?1 \
        ORDER BY COALESCE(time_updated, time_created, 0) DESC \
        LIMIT 400";
    if let Some(rows) = opencode_query(conn, session_only, cwd) {
        return rows;
    }

    let minimal = "\
        SELECT id, \
               COALESCE(NULLIF(TRIM(title), ''), substr(id, 1, 13)) AS title, \
               CAST(COALESCE(time_updated, time_created, 0) AS INTEGER) AS mtime \
        FROM session \
        WHERE directory = ?1 \
        ORDER BY COALESCE(time_updated, time_created, 0) DESC \
        LIMIT 400";
    opencode_query(conn, minimal, cwd).unwrap_or_default()
}

fn opencode_query(conn: &Connection, sql: &str, cwd: &str) -> Option<Vec<AgentSession>> {
    let mut stmt = conn.prepare(sql).ok()?;
    let rows = stmt
        .query_map([cwd], |row| {
            Ok(AgentSession {
                id: row.get::<_, String>(0)?,
                title: row.get::<_, String>(1)?,
                mtime: normalize_unix_secs(row.get::<_, i64>(2).unwrap_or(0).max(0) as u64),
            })
        })
        .ok()?;
    Some(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(test)]
mod executable_tests {
    use super::{
        allowed_agent_path_for_home, cached_title, codex_title, json_effort, parse_claude_models,
        parse_claude_usage, parse_codex_models, parse_codex_usage_result, parse_hermes_models,
        parse_line_models, parse_pi_models, qualify_model, title_cache_stamp, toml_effort,
        toml_model, yaml_agent_reasoning_effort, yaml_model_section, AgentModelInfo,
        AgentUsageResetAt, CLAUDE_MODEL_CATALOG_ARGS,
    };
    #[cfg(unix)]
    use super::{run_model_catalog_executable, MODEL_CATALOG_ERROR_DETAIL_LIMIT};
    use std::io::Write;
    use std::path::Path;

    #[test]
    fn opencode_cache_executables_are_rejected_with_any_windows_suffix() {
        let home = Path::new("/home/tester");
        for name in ["opencode", "opencode.exe", "opencode.cmd"] {
            assert!(!allowed_agent_path_for_home(
                "opencode",
                &home.join(".opencode").join("bin").join(name),
                home,
            ));
        }
        assert!(allowed_agent_path_for_home(
            "opencode",
            Path::new("/usr/local/bin/opencode"),
            home,
        ));
    }

    #[test]
    fn codex_defaults_come_only_from_the_root_config() {
        let config = r#"
            model = "gpt-5.6-sol" # the CLI default
            model_reasoning_effort = "high"
            [profiles.review]
            model = "gpt-5.6-terra"
            model_reasoning_effort = "xhigh"
        "#;
        assert_eq!(toml_model(config).as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(toml_effort(config).as_deref(), Some("high"));
        assert_eq!(
            toml_model(
                r#"
                [profiles.review]
                model = "gpt-5.6-terra"
                "#,
            ),
            None
        );
        assert_eq!(
            toml_effort(
                r#"
                [profiles.review]
                model_reasoning_effort = "xhigh"
                "#,
            ),
            None
        );
    }

    #[test]
    fn provider_models_are_qualified_without_rewriting_full_ids() {
        assert_eq!(
            qualify_model(Some("openai-codex"), Some("gpt-5.6-terra")).as_deref(),
            Some("openai-codex/gpt-5.6-terra")
        );
        assert_eq!(
            qualify_model(Some("anthropic"), Some("openrouter/claude-opus-5")).as_deref(),
            Some("openrouter/claude-opus-5")
        );
    }

    #[test]
    fn json_cli_effort_defaults_use_each_providers_config_key() {
        let mut config = tempfile::NamedTempFile::new().unwrap();
        write!(
            config,
            r#"{{"effortLevel":"xhigh","defaultThinkingLevel":"minimal"}}"#
        )
        .unwrap();

        assert_eq!(
            json_effort(config.path(), "effortLevel", "claude").as_deref(),
            Some("xhigh")
        );
        assert_eq!(
            json_effort(config.path(), "defaultThinkingLevel", "pi").as_deref(),
            Some("minimal")
        );
        assert_eq!(
            json_effort(config.path(), "defaultThinkingLevel", "claude"),
            None,
            "provider-invalid defaults must not leak into launch choices"
        );
    }

    #[test]
    fn hermes_default_model_comes_from_its_model_section() {
        let config = r#"
            model:
              provider: deepseek
              default: deepseek-v4-flash
            agent:
              reasoning_effort: high
            compression:
              reasoning_effort: low
            "#;
        let (provider, model) = yaml_model_section(config);
        assert_eq!(provider.as_deref(), Some("deepseek"));
        assert_eq!(model.as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(yaml_agent_reasoning_effort(config).as_deref(), Some("high"));
    }

    #[test]
    fn codex_catalog_keeps_only_visible_full_model_ids() {
        let models = parse_codex_models(
            r#"{"models":[
                {"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol","visibility":"list"},
                {"slug":"internal-model","display_name":"Internal","visibility":"hide"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(
            models,
            vec![AgentModelInfo {
                id: "gpt-5.6-sol".into(),
                label: "GPT-5.6-Sol".into()
            }]
        );
    }

    #[test]
    fn claude_catalog_replaces_aliases_with_resolved_model_ids() {
        let models = parse_claude_models(
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"test-models","response":{"models":[{"value":"default","resolvedModel":"claude-opus-5[1m]","displayName":"Default"},{"value":"opus[1m]","resolvedModel":"claude-opus-5[1m]","displayName":"Opus"},{"value":"sonnet","resolvedModel":"claude-sonnet-5","displayName":"Sonnet"},{"value":"haiku","resolvedModel":"claude-haiku-4-5-20251001","displayName":"Haiku"}]}}}"#,
            "test-models",
        );
        assert_eq!(
            models,
            vec![
                AgentModelInfo {
                    id: "claude-opus-5[1m]".into(),
                    label: "Opus".into()
                },
                AgentModelInfo {
                    id: "claude-sonnet-5".into(),
                    label: "Sonnet".into()
                },
                AgentModelInfo {
                    id: "claude-haiku-4-5-20251001".into(),
                    label: "Haiku".into()
                }
            ]
        );
    }

    #[test]
    fn claude_catalog_enables_print_mode_for_stream_json() {
        assert!(CLAUDE_MODEL_CATALOG_ARGS.contains(&"--print"));
        assert!(CLAUDE_MODEL_CATALOG_ARGS
            .windows(2)
            .any(|args| args == ["--input-format", "stream-json"]));
        assert!(CLAUDE_MODEL_CATALOG_ARGS
            .windows(2)
            .any(|args| args == ["--output-format", "stream-json"]));
    }

    #[test]
    fn claude_usage_normalizes_plan_windows_and_model_scopes() {
        let usage = parse_claude_usage(
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"test-usage","response":{"subscription_type":"max","rate_limits":{"five_hour":{"utilization":21.5,"resets_at":"2026-08-13T12:00:00Z"},"seven_day":{"utilization":64,"resets_at":"2026-08-18T09:30:00Z"},"seven_day_opus":null,"model_scoped":[{"display_name":"Fable","utilization":9,"resets_at":"2026-08-20T00:00:00Z"}]}}}}"#,
            "test-usage",
        )
        .unwrap();

        assert_eq!(usage.provider, "claude");
        assert_eq!(usage.plan.as_deref(), Some("max"));
        assert_eq!(
            usage
                .windows
                .iter()
                .map(|window| window.label.as_str())
                .collect::<Vec<_>>(),
            vec!["5h", "7d", "Fable · 7d"]
        );
        assert_eq!(usage.windows[0].used_percent, 21.5);
        assert_eq!(usage.windows[0].window_minutes, Some(300));
        assert_eq!(
            usage.windows[0].resets_at,
            Some(AgentUsageResetAt::Iso("2026-08-13T12:00:00Z".to_string()))
        );
    }

    #[test]
    fn codex_usage_prefers_multi_bucket_data_and_preserves_named_limits() {
        let usage = parse_codex_usage_result(&serde_json::json!({
            "rateLimits": {
                "limitId": "stale",
                "planType": "free",
                "primary": { "usedPercent": 99, "windowDurationMins": 60, "resetsAt": 1 }
            },
            "rateLimitsByLimitId": {
                "codex_spark": {
                    "limitId": "codex_spark",
                    "limitName": "GPT-5.3-Codex-Spark",
                    "planType": "pro",
                    "primary": { "usedPercent": 3, "windowDurationMins": 10080, "resetsAt": 1787220418 }
                },
                "codex": {
                    "limitId": "codex",
                    "planType": "pro",
                    "primary": { "usedPercent": 4, "windowDurationMins": 300, "resetsAt": 1786998646 },
                    "secondary": { "usedPercent": 17, "windowDurationMins": 10080, "resetsAt": 1787157619 }
                }
            }
        }));

        assert_eq!(usage.provider, "codex");
        assert_eq!(usage.plan.as_deref(), Some("pro"));
        assert_eq!(
            usage
                .windows
                .iter()
                .map(|window| window.label.as_str())
                .collect::<Vec<_>>(),
            vec!["5h", "7d", "GPT-5.3-Codex-Spark · 7d"]
        );
        assert_eq!(usage.windows[1].used_percent, 17.0);
        assert_eq!(
            usage.windows[1].resets_at,
            Some(AgentUsageResetAt::Unix(1787157619))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn model_catalog_subprocess_captures_stdout() {
        let output = run_model_catalog_executable(
            "test-agent",
            Path::new("/bin/sh"),
            &["-c", "printf '%s' '{\"models\":[]}'"],
            None,
        )
        .await
        .unwrap();

        assert_eq!(output, r#"{"models":[]}"#);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn model_catalog_subprocess_surfaces_bounded_stderr() {
        let long_detail = "x".repeat(MODEL_CATALOG_ERROR_DETAIL_LIMIT + 20);
        let script = format!("printf 'first\\nsecond {long_detail}' >&2; exit 7");
        let error = run_model_catalog_executable(
            "test-agent",
            Path::new("/bin/sh"),
            &["-c", &script],
            None,
        )
        .await
        .unwrap_err();

        assert!(error.starts_with("test-agent model lookup exited unsuccessfully: first second "));
        assert!(error.ends_with('…'));
        assert!(error.chars().count() <= MODEL_CATALOG_ERROR_DETAIL_LIMIT + 52);
    }

    #[test]
    fn line_catalogs_preserve_provider_qualified_ids() {
        assert_eq!(
            parse_pi_models(
                "provider model context\nopenai-codex gpt-5.6-sol 272K\nanthropic claude-opus-5 1M\n"
            ),
            vec![
                AgentModelInfo {
                    id: "openai-codex/gpt-5.6-sol".into(),
                    label: "openai-codex/gpt-5.6-sol".into()
                },
                AgentModelInfo {
                    id: "anthropic/claude-opus-5".into(),
                    label: "anthropic/claude-opus-5".into()
                }
            ]
        );
        assert_eq!(
            parse_line_models("opencode/big-pickle\nollama/qwen3\n"),
            vec![
                AgentModelInfo {
                    id: "opencode/big-pickle".into(),
                    label: "opencode/big-pickle".into()
                },
                AgentModelInfo {
                    id: "ollama/qwen3".into(),
                    label: "ollama/qwen3".into()
                }
            ]
        );
    }

    #[test]
    fn hermes_catalog_uses_only_the_configured_provider() {
        let models = parse_hermes_models(
            r#"{
                "deepseek":{"models":["deepseek-v4-pro","deepseek-v4-flash"]},
                "anthropic":{"models":["claude-opus-5"]}
            }"#,
            "deepseek",
        )
        .unwrap();
        assert_eq!(
            models,
            vec![
                AgentModelInfo {
                    id: "deepseek/deepseek-v4-pro".into(),
                    label: "deepseek/deepseek-v4-pro".into()
                },
                AgentModelInfo {
                    id: "deepseek/deepseek-v4-flash".into(),
                    label: "deepseek/deepseek-v4-flash".into()
                }
            ]
        );
    }

    #[test]
    fn codex_title_reads_the_current_user_message_shape() {
        let mut transcript = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            transcript,
            r#"{{"type":"session_meta","payload":{{"id":"session-1","cwd":"/repo"}}}}"#
        )
        .unwrap();
        writeln!(
            transcript,
            r#"{{"type":"event_msg","payload":{{"type":"user_message","message":"Explain this codebase"}}}}"#
        )
        .unwrap();
        transcript.flush().unwrap();

        assert_eq!(
            codex_title(transcript.path()).as_deref(),
            Some("Explain this codebase")
        );
    }

    #[test]
    fn title_cache_rechecks_a_transcript_after_a_same_tick_append() {
        let mut transcript = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            transcript,
            r#"{{"type":"session_meta","payload":{{"id":"session-1","cwd":"/repo"}}}}"#
        )
        .unwrap();
        transcript.flush().unwrap();
        let first_stamp = title_cache_stamp(transcript.path());
        assert_eq!(
            cached_title(transcript.path(), first_stamp, || codex_title(
                transcript.path()
            )),
            None
        );

        writeln!(
            transcript,
            r#"{{"type":"event_msg","payload":{{"type":"user_message","message":"Hello"}}}}"#
        )
        .unwrap();
        transcript.flush().unwrap();
        let second_stamp = title_cache_stamp(transcript.path());
        assert_ne!(first_stamp.len, second_stamp.len);
        assert_eq!(
            cached_title(transcript.path(), second_stamp, || codex_title(
                transcript.path()
            ))
            .as_deref(),
            Some("Hello")
        );
    }
}
