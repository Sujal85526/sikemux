//! Every agent host learns about the browser tools a different way: a config
//! file named on the command line, a dotted override, an extension, or its own
//! home directory. This is that per-host knowledge in one place.
//!
//! A host's existing MCP servers are never disturbed. Each integration either
//! adds to what the user already configured or works on a private copy of the
//! host's home, so an agent launched outside Sikemux is unaffected.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use sikemux_core::acp::schema::v1::{EnvVariable, McpServer, McpServerStdio};
use sikemux_pty::user_shell::user_variable;
use tauri::{AppHandle, Manager};

use super::agent_skills;
use super::{browser_state_dir, validate_agent_id, BrowserManager, BrowserMcpLaunch};
use crate::error::{AppError, AppResult};

const CONFIG_TIMEOUT: Duration = Duration::from_secs(5);

/// The hosts that can be told about the browser tools. Anything else launches
/// untouched.
pub fn is_supported(agent_type: &str) -> bool {
    crate::agents::AgentKind::from_name(agent_type).is_some()
}

/// What the agent needs to start with: arguments in front of the ones the pane
/// already built, and environment for its process.
pub struct BrowserAgentIntegration {
    pub args_prefix: Vec<String>,
    pub environment: Vec<(String, String)>,
}

impl BrowserAgentIntegration {
    /// Fold these arguments into the launch the pane built, and hand back the
    /// environment. Sikemux's go first: a host that takes a subcommand wants
    /// its options before it.
    pub fn apply(mut self, args: &mut Vec<String>) -> Vec<(String, String)> {
        self.args_prefix.append(args);
        *args = self.args_prefix;
        self.environment
    }
}

impl BrowserManager {
    pub async fn agent_integration(
        &self,
        app: &AppHandle,
        agent_id: &str,
        agent_type: &str,
        agent_program: &str,
    ) -> AppResult<BrowserAgentIntegration> {
        validate_agent_id(agent_id)?;
        let launch = self.mcp_launch()?;
        let mut environment = base_environment(agent_id)?;
        let data_dir = skills_data_dir(app);
        let data_dir = data_dir.as_deref();
        let args_prefix = match agent_type {
            "claude" => {
                let mut args = claude_browser_args(app, &launch)?;
                args.extend(skill_args(data_dir, agent_skills::claude_args));
                args
            }
            "codex" => codex_browser_args(&launch)?,
            "pi" | "omp" => {
                environment.push(("SIKEMUX_TOOLS_MCP_COMMAND".into(), launch.command.clone()));
                environment.push((
                    "SIKEMUX_TOOLS_MCP_ARGS".into(),
                    serde_json::to_string(&launch.args)?,
                ));
                let mut args = vec![
                    "--extension".into(),
                    pi_browser_extension(app)?.to_string_lossy().into_owned(),
                ];
                args.extend(if agent_type == "pi" {
                    skill_args(data_dir, |dir| Ok(agent_skills::pi_args(dir)))
                } else {
                    skill_args(data_dir, agent_skills::omp_args)
                });
                args
            }
            "hermes" => {
                let home =
                    prepare_hermes_home(app, agent_id, agent_program, &launch, data_dir).await?;
                environment.push(("HERMES_HOME".into(), home.to_string_lossy().into_owned()));
                Vec::new()
            }
            "grok" => {
                let home =
                    prepare_grok_home(app, agent_id, agent_program, &launch, data_dir).await?;
                environment.push(("GROK_HOME".into(), home.to_string_lossy().into_owned()));
                Vec::new()
            }
            "muse" => muse_browser_args(&launch, &environment)?,
            "opencode" => {
                environment.push((
                    "OPENCODE_CONFIG_CONTENT".into(),
                    opencode_browser_config(
                        inherited_opencode_config().as_deref(),
                        &launch,
                        data_dir
                            .map(|dir| (opencode_own_skill_paths(), agent_skills::library(dir))),
                    )?,
                ));
                Vec::new()
            }
            _ => return Err(AppError::BadArg("unsupported browser agent type")),
        };
        Ok(BrowserAgentIntegration {
            args_prefix,
            environment,
        })
    }
}

/// An ACP agent is handed its servers over the protocol itself, so this path
/// has no config file and no flag. It is a separate transport from the
/// terminal one above and needs telling too.
pub fn acp_browser_server(app: &AppHandle, agent_id: &str) -> AppResult<McpServer> {
    validate_agent_id(agent_id)?;
    let launch = app.state::<BrowserManager>().mcp_launch()?;
    let mut server = McpServerStdio::new("sikemux-tools", absolute_command(&launch.command)?);
    server.args = launch.args;
    server.env = base_environment(agent_id)?
        .into_iter()
        .map(|(name, value)| EnvVariable::new(name, value))
        .collect();
    Ok(McpServer::Stdio(server))
}

/// Hands a chat launch the Sikemux skills library. Chats take a separate
/// path from terminals, and for Hermes and Grok a separate private home,
/// since the tools reach them over the protocol rather than their config.
pub async fn chat_skills(
    app: &AppHandle,
    agent_id: Option<&str>,
    provider: &str,
    program: &Path,
    args: &mut Vec<String>,
    env: &mut BTreeMap<String, String>,
) {
    let Some(data_dir) = skills_data_dir(app) else {
        return;
    };
    let library = agent_skills::library(&data_dir);
    env.insert(
        sikemux_core::skills::LIBRARY_ENV.into(),
        library.to_string_lossy().into_owned(),
    );
    let program = program.to_string_lossy();
    match (provider, agent_id) {
        ("claude", _) => {
            let front = skill_args(Some(&data_dir), agent_skills::claude_args);
            args.splice(0..0, front);
        }
        ("omp", _) => args.extend(skill_args(Some(&data_dir), agent_skills::omp_args)),
        ("opencode", _) => {
            let existing = env
                .get("OPENCODE_CONFIG_CONTENT")
                .cloned()
                .or_else(inherited_opencode_config);
            if let Some(config) =
                chat_opencode_config(existing.as_deref(), &opencode_own_skill_paths(), &library)
            {
                env.insert("OPENCODE_CONFIG_CONTENT".into(), config);
            }
        }
        ("hermes", Some(agent_id)) => {
            match chat_hermes_home(app, agent_id, &program, &library).await {
                Ok(home) => {
                    env.insert("HERMES_HOME".into(), home.to_string_lossy().into_owned());
                }
                Err(error) => {
                    eprintln!("Sikemux skills are unavailable to this Hermes chat: {error}")
                }
            }
        }
        ("grok", Some(agent_id)) => match chat_grok_home(app, agent_id, &library) {
            Ok(home) => {
                env.insert("GROK_HOME".into(), home.to_string_lossy().into_owned());
            }
            Err(error) => eprintln!("Sikemux skills are unavailable to this Grok chat: {error}"),
        },
        _ => {}
    }
}

async fn chat_hermes_home(
    app: &AppHandle,
    agent_id: &str,
    program: &str,
    library: &Path,
) -> AppResult<PathBuf> {
    let real = crate::agents::config::hermes_root()
        .ok_or_else(|| AppError::Other("the home folder is unavailable".into()))?;
    share_session_store(&real, "state.db", false)?;
    let home = private_home(app, "hermes-chat", agent_id, &real, "config.yaml", "{}\n")?;
    let config = std::fs::read_to_string(home.join("config.yaml")).unwrap_or_default();
    let dirs = agent_skills::hermes_external_dirs(&config, library);
    run_config_command(
        program,
        &["config", "set", "skills.external_dirs", &dirs, "--force"],
        ("HERMES_HOME", &home),
        "Hermes",
    )
    .await?;
    Ok(home)
}

fn chat_grok_home(app: &AppHandle, agent_id: &str, library: &Path) -> AppResult<PathBuf> {
    let real = crate::agents::config::grok_root()
        .ok_or_else(|| AppError::Other("the home folder is unavailable".into()))?;
    share_session_store(&real, "sessions", true)?;
    let home = private_home(app, "grok-chat", agent_id, &real, "config.toml", "")?;
    let path = home.join("config.toml");
    let config = std::fs::read_to_string(&path).unwrap_or_default();
    let merged = agent_skills::grok_config(&config, library).map_err(AppError::Other)?;
    std::fs::write(&path, merged)?;
    Ok(home)
}

/// An OpenCode chat's inline config with the skills library added. A config
/// that is not plain JSON is left as the person wrote it, without the skills.
fn chat_opencode_config(
    existing: Option<&str>,
    own_paths: &[String],
    library: &Path,
) -> Option<String> {
    let mut config = match existing.map(str::trim).filter(|text| !text.is_empty()) {
        None => json!({}),
        Some(text) => serde_json::from_str::<Value>(text)
            .ok()
            .filter(Value::is_object)?,
    };
    agent_skills::add_opencode_paths(&mut config, own_paths, library);
    Some(config.to_string())
}

/// Makes the store an agent keeps its sessions in inside its real home, if it
/// has none yet, so a private home links to it rather than starting its own.
/// Sikemux lists and resumes sessions from the real home.
fn share_session_store(real_home: &Path, name: &str, folder: bool) -> std::io::Result<()> {
    let store = real_home.join(name);
    if std::fs::symlink_metadata(&store).is_ok() {
        return Ok(());
    }
    std::fs::create_dir_all(real_home)?;
    if folder {
        std::fs::create_dir_all(&store)
    } else {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&store)
            .map(|_| ())
    }
}

/// The app data folder with the skills library ready in it. Without one,
/// agents launch without Sikemux skills rather than pointed at a missing folder.
fn skills_data_dir(app: &AppHandle) -> Option<PathBuf> {
    let data_dir = app.path().app_data_dir().ok()?;
    match sikemux_core::skills::ready_library(&data_dir) {
        Ok(_) => Some(data_dir),
        Err(error) => {
            eprintln!("Sikemux skills are unavailable: {error}");
            None
        }
    }
}

/// The protocol asks for an absolute path, and a development launch runs
/// through a program found on PATH.
fn absolute_command(command: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(command);
    if path.is_absolute() {
        return Ok(path);
    }
    crate::system::find_executable(command)
        .ok_or_else(|| AppError::Other(format!("{command} is not on PATH")))
}

/// What the MCP sidecar reads once the host spawns it. The sidecar inherits
/// this through the agent process, so it never appears in a config file.
fn base_environment(agent_id: &str) -> AppResult<Vec<(String, String)>> {
    let environment = vec![
        ("SIKEMUX_TOOLS_AGENT_ID".into(), agent_id.to_owned()),
        (
            "SIKEMUX_CLI_ENDPOINT".into(),
            crate::cli_paths::cli_endpoint_path()
                .ok_or_else(|| AppError::Other("CLI endpoint unavailable".into()))?
                .to_string_lossy()
                .into_owned(),
        ),
    ];
    Ok(environment)
}

fn mcp_server_document(launch: &BrowserMcpLaunch) -> Value {
    json!({
        "type": "stdio",
        "command": launch.command,
        "args": launch.args,
    })
}

/// Claude Code merges `--mcp-config` with the servers the user already has,
/// so this adds the browser without hiding anything else. The flag takes a
/// list, so it is written as one `=` token: given a separate one it would
/// swallow whatever plain word came next.
fn claude_browser_args(app: &AppHandle, launch: &BrowserMcpLaunch) -> AppResult<Vec<String>> {
    let directory = browser_state_dir(app)?;
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("claude-mcp.json");
    let document = json!({ "mcpServers": { "sikemux-tools": mcp_server_document(launch) } });
    sikemux_process::files::write_atomic(&path, &serde_json::to_vec_pretty(&document)?, false)?;
    Ok(vec![format!("--mcp-config={}", path.to_string_lossy())])
}

fn codex_browser_args(launch: &BrowserMcpLaunch) -> AppResult<Vec<String>> {
    let command = serde_json::to_string(&launch.command)?;
    let args = serde_json::to_string(&launch.args)?;
    Ok(vec![
        "-c".into(),
        format!("mcp_servers.sikemux_tools.command={command}"),
        "-c".into(),
        format!("mcp_servers.sikemux_tools.args={args}"),
    ])
}

/// Muse adds one named server from a `-c` override to the ones it already
/// has. It starts tool servers with only the environment it is given, so the
/// sidecar's is named in the server itself.
fn muse_browser_args(
    launch: &BrowserMcpLaunch,
    environment: &[(String, String)],
) -> AppResult<Vec<String>> {
    let server = json!({
        "transport": "stdio",
        "command": launch.command,
        "args": launch.args,
        "env": environment
            .iter()
            .map(|(name, value)| (name.clone(), Value::from(value.as_str())))
            .collect::<serde_json::Map<String, Value>>(),
        "mode": "optional",
    });
    Ok(vec![
        "-c".into(),
        format!(
            "mcpServers.sikemux-tools={}",
            serde_json::to_string(&server)?
        ),
    ])
}

/// Skills arguments for one launch. A library that cannot be set up costs the
/// agent its Sikemux skills, never its launch.
fn skill_args(
    data_dir: Option<&Path>,
    make: impl FnOnce(&Path) -> std::io::Result<Vec<String>>,
) -> Vec<String> {
    let Some(data_dir) = data_dir else {
        return Vec::new();
    };
    make(data_dir).unwrap_or_else(|error| {
        eprintln!("Sikemux skills are unavailable to this agent: {error}");
        Vec::new()
    })
}

fn opencode_own_skill_paths() -> Vec<String> {
    let config_home = user_variable("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::system::user_home().join(".config"));
    agent_skills::opencode_own_paths(&config_home.join("opencode"))
}

fn inherited_opencode_config() -> Option<String> {
    user_variable("OPENCODE_CONFIG_CONTENT")
}

fn opencode_browser_config(
    existing: Option<&str>,
    launch: &BrowserMcpLaunch,
    skills: Option<(Vec<String>, PathBuf)>,
) -> AppResult<String> {
    let mut config = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(existing) => serde_json::from_str::<Value>(existing)
            .map_err(|_| AppError::BadArg("invalid OPENCODE_CONFIG_CONTENT"))?,
        None => json!({}),
    };
    let root = config
        .as_object_mut()
        .ok_or(AppError::BadArg("invalid OPENCODE_CONFIG_CONTENT"))?;
    let mcp = root
        .entry("mcp")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or(AppError::BadArg("invalid OpenCode MCP config"))?;
    let mut command = vec![launch.command.clone()];
    command.extend(launch.args.iter().cloned());
    mcp.insert(
        "sikemux_tools".into(),
        json!({ "type": "local", "command": command, "enabled": true }),
    );
    if let Some((own_paths, library)) = skills {
        agent_skills::add_opencode_paths(&mut config, &own_paths, &library);
    }
    serde_json::to_string(&config).map_err(AppError::from)
}

fn pi_browser_extension(app: &AppHandle) -> AppResult<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let path = resource_dir.join("sikemux_pi_tools.ts");
        if path.is_file() {
            return Ok(path);
        }
    }
    #[cfg(debug_assertions)]
    {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("sikemux_pi_tools.ts");
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(AppError::Other(
        "bundled Pi browser extension is missing".into(),
    ))
}

async fn prepare_hermes_home(
    app: &AppHandle,
    agent_id: &str,
    agent_program: &str,
    launch: &BrowserMcpLaunch,
    data_dir: Option<&Path>,
) -> AppResult<PathBuf> {
    let home = private_home(
        app,
        "hermes",
        agent_id,
        &crate::agents::config::hermes_root()
            .ok_or_else(|| AppError::Other("the home folder is unavailable".into()))?,
        "config.yaml",
        "{}\n",
    )?;
    let server = json!({
        "command": launch.command,
        "args": launch.args,
        "enabled": true,
    })
    .to_string();
    run_config_command(
        agent_program,
        &[
            "config",
            "set",
            "mcp_servers.sikemux_tools",
            &server,
            "--force",
        ],
        ("HERMES_HOME", &home),
        "Hermes",
    )
    .await?;
    if let Some(data_dir) = data_dir {
        let config = std::fs::read_to_string(home.join("config.yaml")).unwrap_or_default();
        let dirs = agent_skills::hermes_external_dirs(&config, &agent_skills::library(data_dir));
        if let Err(error) = run_config_command(
            agent_program,
            &["config", "set", "skills.external_dirs", &dirs, "--force"],
            ("HERMES_HOME", &home),
            "Hermes",
        )
        .await
        {
            eprintln!("Sikemux skills are unavailable to Hermes: {error}");
        }
    }
    Ok(home)
}

async fn prepare_grok_home(
    app: &AppHandle,
    agent_id: &str,
    agent_program: &str,
    launch: &BrowserMcpLaunch,
    data_dir: Option<&Path>,
) -> AppResult<PathBuf> {
    let home = private_home(
        app,
        "grok",
        agent_id,
        &crate::agents::config::grok_root()
            .ok_or_else(|| AppError::Other("the home folder is unavailable".into()))?,
        "config.toml",
        "",
    )?;
    let mut args = vec!["mcp", "add", "sikemux_tools", "--", launch.command.as_str()];
    args.extend(launch.args.iter().map(String::as_str));
    run_config_command(agent_program, &args, ("GROK_HOME", &home), "Grok").await?;
    if let Some(data_dir) = data_dir {
        let path = home.join("config.toml");
        let config = std::fs::read_to_string(&path).unwrap_or_default();
        match agent_skills::grok_config(&config, &agent_skills::library(data_dir)) {
            Ok(config) => std::fs::write(&path, config)?,
            Err(error) => eprintln!("Sikemux skills are unavailable to Grok: {error}"),
        }
    }
    Ok(home)
}

/// A private copy of the host's home: every entry is linked back to the real
/// one, except the config file, which is copied so Sikemux can add a server to
/// it without touching the user's own.
fn private_home(
    app: &AppHandle,
    host: &str,
    agent_id: &str,
    source: &Path,
    config_name: &str,
    empty_config: &str,
) -> AppResult<PathBuf> {
    let destination = browser_state_dir(app)?.join(host).join(agent_id);
    std::fs::create_dir_all(&destination)?;
    match std::fs::read_dir(source) {
        Ok(entries) => {
            for entry in entries.flatten() {
                if entry.file_name() == config_name {
                    continue;
                }
                link_entry(&entry.path(), &destination.join(entry.file_name()))?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let config = destination.join(config_name);
    let source_config = source.join(config_name);
    if source_config.is_file() {
        std::fs::copy(source_config, &config)?;
    } else if !config.is_file() {
        std::fs::write(&config, empty_config)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o700))?;
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(destination)
}

fn link_entry(source: &Path, destination: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(destination).is_ok() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, destination)
    }
    #[cfg(windows)]
    {
        if source.is_dir() {
            std::os::windows::fs::symlink_dir(source, destination)
        } else {
            std::os::windows::fs::symlink_file(source, destination)
                .or_else(|_| std::fs::hard_link(source, destination))
                .or_else(|_| std::fs::copy(source, destination).map(|_| ()))
        }
    }
}

async fn run_config_command(
    program: &str,
    args: &[&str],
    home: (&str, &Path),
    label: &str,
) -> AppResult<()> {
    let output = tokio::time::timeout(
        CONFIG_TIMEOUT,
        tokio::process::Command::from(sikemux_process::user_environment::command(program))
            .args(args)
            .env(home.0, home.1)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| AppError::Other(format!("{label} browser config timed out")))?
    .map_err(|error| AppError::Other(format!("{label} browser config failed: {error}")))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr)
        .chars()
        .take(512)
        .collect::<String>();
    Err(AppError::Other(format!(
        "{label} browser config failed: {}",
        detail.trim()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch() -> BrowserMcpLaunch {
        BrowserMcpLaunch {
            command: "/Apps/Sikemux.app/sikemux-editor".into(),
            args: vec!["--tools-mcp".into()],
        }
    }

    #[test]
    fn an_opencode_chat_keeps_an_inline_config_it_cannot_read_untouched() {
        let library = Path::new("/data/skills");
        let added = chat_opencode_config(Some(r#"{"provider":{"x":{}}}"#), &[], library).unwrap();
        assert!(added.contains("/data/skills") && added.contains("provider"));
        assert!(chat_opencode_config(None, &[], library)
            .unwrap()
            .contains("/data/skills"));
        assert_eq!(
            chat_opencode_config(Some("{ // mine\n \"provider\": {}, }"), &[], library),
            None
        );
    }

    #[test]
    fn a_session_store_is_made_in_the_real_home_only_when_missing() {
        let home = tempfile::tempdir().unwrap();
        share_session_store(home.path(), "sessions", true).unwrap();
        share_session_store(home.path(), "state.db", false).unwrap();
        assert!(home.path().join("sessions").is_dir());
        assert_eq!(
            std::fs::metadata(home.path().join("state.db"))
                .unwrap()
                .len(),
            0
        );

        std::fs::write(home.path().join("state.db"), "kept").unwrap();
        share_session_store(home.path(), "state.db", false).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.path().join("state.db")).unwrap(),
            "kept"
        );
    }

    #[test]
    fn opencode_adds_the_skills_library_beside_the_tools() {
        let library = PathBuf::from("/data/skills");
        let config: Value = serde_json::from_str(
            &opencode_browser_config(
                Some(r#"{"skills":{"paths":["/inherited"]}}"#),
                &launch(),
                Some((vec!["/own".into()], library)),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            config["skills"]["paths"],
            json!(["/inherited", "/own", "/data/skills"])
        );
        assert!(config["mcp"]["sikemux_tools"].is_object());
    }

    #[test]
    fn sikemux_options_land_before_the_launch_the_pane_built() {
        let integration = BrowserAgentIntegration {
            args_prefix: vec!["--mcp-config=/state/claude-mcp.json".into()],
            environment: vec![("SIKEMUX_TOOLS_AGENT_ID".into(), "agent-one".into())],
        };
        let mut args = vec![
            "--model".to_string(),
            "opus".into(),
            "--resume".into(),
            "abc".into(),
        ];
        let environment = integration.apply(&mut args);
        assert_eq!(
            args,
            vec![
                "--mcp-config=/state/claude-mcp.json",
                "--model",
                "opus",
                "--resume",
                "abc"
            ]
        );
        assert_eq!(environment.len(), 1);
    }

    /// An ACP adapter tells a stdio server apart by the absence of a type
    /// tag, so the shape matters as much as the values.
    #[test]
    fn an_acp_stdio_server_is_untagged_with_its_environment_spelled_out() {
        let mut stdio = McpServerStdio::new("sikemux-tools", "/apps/sikemux-editor");
        stdio.args = vec!["--tools-mcp".into()];
        stdio.env = vec![EnvVariable::new("SIKEMUX_TOOLS_AGENT_ID", "agent-one")];
        let value = serde_json::to_value(McpServer::Stdio(stdio)).unwrap();
        assert!(value.get("type").is_none(), "{value}");
        assert_eq!(value["name"], "sikemux-tools");
        assert_eq!(value["command"], "/apps/sikemux-editor");
        assert_eq!(value["args"], json!(["--tools-mcp"]));
        assert_eq!(value["env"][0]["name"], "SIKEMUX_TOOLS_AGENT_ID");
        assert_eq!(value["env"][0]["value"], "agent-one");
    }

    #[test]
    fn an_acp_session_is_given_an_absolute_command_even_in_development() {
        assert_eq!(
            absolute_command("/bin/sh").unwrap(),
            PathBuf::from("/bin/sh")
        );
        let found = absolute_command("sh").unwrap();
        assert!(found.is_absolute(), "{found:?} should be absolute");
        assert!(absolute_command("sikemux-no-such-program").is_err());
    }

    #[test]
    fn codex_learns_the_server_through_dotted_overrides() {
        assert_eq!(
            codex_browser_args(&launch()).unwrap(),
            vec![
                "-c".to_string(),
                "mcp_servers.sikemux_tools.command=\"/Apps/Sikemux.app/sikemux-editor\""
                    .to_string(),
                "-c".to_string(),
                "mcp_servers.sikemux_tools.args=[\"--tools-mcp\"]".to_string(),
            ]
        );
    }

    #[test]
    fn claude_is_handed_a_stdio_server_named_for_sikemux() {
        let document = json!({ "mcpServers": { "sikemux-tools": mcp_server_document(&launch()) } });
        let server = &document["mcpServers"]["sikemux-tools"];
        assert_eq!(server["type"], "stdio");
        assert_eq!(server["command"], "/Apps/Sikemux.app/sikemux-editor");
        assert_eq!(server["args"], json!(["--tools-mcp"]));
    }

    #[test]
    fn opencode_keeps_the_settings_it_already_had() {
        let existing = r#"{"theme":"dark","mcp":{"other":{"type":"local"}}}"#;
        let merged: Value = serde_json::from_str(
            &opencode_browser_config(Some(existing), &launch(), None).unwrap(),
        )
        .unwrap();
        assert_eq!(merged["theme"], "dark");
        assert_eq!(merged["mcp"]["other"]["type"], "local");
        assert_eq!(
            merged["mcp"]["sikemux_tools"]["command"],
            json!(["/Apps/Sikemux.app/sikemux-editor", "--tools-mcp"])
        );
        assert_eq!(merged["mcp"]["sikemux_tools"]["enabled"], true);
    }

    #[test]
    fn opencode_starts_from_nothing_and_refuses_junk() {
        let fresh: Value =
            serde_json::from_str(&opencode_browser_config(None, &launch(), None).unwrap()).unwrap();
        assert!(fresh["mcp"]["sikemux_tools"].is_object());
        assert!(opencode_browser_config(Some("   "), &launch(), None).is_ok());
        assert!(opencode_browser_config(Some("not json"), &launch(), None).is_err());
        assert!(opencode_browser_config(Some("[1,2]"), &launch(), None).is_err());
    }
}
