//! The projects the app has open and the agents it can start, kept by the
//! core across restarts so a paired device can start or wake a chat with no
//! app running. Launchers name an agent, never its environment: a launch
//! builds that afresh, keys and all.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use agent_client_protocol::schema::v1::{EnvVariable, McpServer, McpServerStdio};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::launch::providers::Providers;
use crate::launch::{skills, AgentSpec};
use crate::protocol::{
    Backdrop, BackdropImage, ChatAccount, ChatInfo, ChatLaunch, ChatState, Event, LauncherInfo,
    ProjectInfo, PublishedChat, PublishedRecent, RecentInfo, RequestId, Response, Workspace,
    WAKE_WAIT,
};

use super::chat;
use super::connection::{blocking, ClientConn};
use super::{Core, CoreError, CoreResult};
use crate::acp::pickers;

const MAX_PROJECTS: usize = 512;
const MAX_LAUNCHERS: usize = 64;
const MAX_CHATS: usize = 1024;
const MAX_RECENT: usize = 100;
const MAX_SESSION_ID_CHARS: usize = 512;
const MAX_TITLE_CHARS: usize = 200;
const MAX_COLOURS: usize = 64;
/// A phone-sized JPEG is a few hundred kilobytes; this leaves room without letting one fill a frame.
const MAX_IMAGE_BYTES: usize = 3 * 1024 * 1024;
const MAX_COLOUR_CHARS: usize = 64;

/// One agent the app offers, on one of the person's accounts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Launcher {
    pub id: String,
    pub label: String,
    #[serde(flatten)]
    pub agent: AgentSpec,
    pub permission_mode: String,
    /// Whether the agent is ready, signed out, missing or broken, as the app last saw it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// The program the core found for the agent.
    #[serde(default)]
    pub program: PathBuf,
}

/// How a chat the app stopped was running, so the core can wake it alone.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asleep {
    agent_id: String,
    launcher: String,
    cwd: PathBuf,
    resume_id: Option<String>,
    permission_mode: String,
    model: Option<String>,
    effort: Option<String>,
    account: Option<ChatAccount>,
    #[serde(default)]
    fallbacks: Vec<ChatAccount>,
}

/// What survives a restart of the core.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    projects: Vec<ProjectInfo>,
    launchers: Vec<Launcher>,
    /// The app's chats, absent until it has said which it holds.
    chats: Option<Vec<PublishedChat>>,
    recent: Vec<PublishedRecent>,
    asleep: Vec<Asleep>,
}

#[derive(Default)]
struct Published {
    saved: Saved,
    titles: BTreeMap<String, String>,
    /// Each provider's `configOptions` from its last session, by provider.
    config_options: BTreeMap<String, Value>,
    palette: BTreeMap<String, String>,
    texture: bool,
    image: Option<BackdropImage>,
    /// How the app runs each of its agents, by agent id.
    runs: BTreeMap<String, AgentRun>,
}

/// The launcher and permission mode the app runs an agent with, which the
/// core cannot read off a terminal agent itself.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRun {
    pub launcher: String,
    pub permission_mode: String,
}

pub(crate) struct Workspaces {
    published: Mutex<Published>,
    /// Where [`Saved`] is kept; nowhere for a core without a data folder.
    path: Option<PathBuf>,
    providers: Option<Providers>,
    /// The data folder, which holds the skills library.
    data_dir: Option<PathBuf>,
    /// Counts the app's workspaces, so one that took longer to look over never replaces a newer one.
    asked: AtomicU64,
}

pub(crate) struct ChatChoice {
    pub launcher: String,
    pub project: String,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// The provider's session to load instead of opening a new one.
    pub resume_id: Option<String>,
}

/// What a device asked of a recent chat it takes up again.
pub(crate) struct ResumeChoice {
    pub recent: String,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

fn recent_id(chat: &PublishedRecent) -> String {
    format!("{}:{}", chat.provider, chat.session_id)
}

fn running_now(chat: &PublishedRecent, open: &[ChatInfo]) -> bool {
    open.iter().any(|live| {
        live.provider == chat.provider
            && live.session_id.as_deref() == Some(chat.session_id.as_str())
    })
}

impl Workspaces {
    pub(crate) fn new(data_dir: Option<&Path>) -> Self {
        let path = data_dir.map(|dir| dir.join("workspace.json"));
        let saved = path
            .as_deref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            published: Mutex::new(Published {
                saved,
                ..Published::default()
            }),
            path,
            providers: data_dir.map(Providers::new),
            data_dir: data_dir.map(Path::to_path_buf),
            asked: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Published> {
        self.published
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, saved: &Saved) {
        let Some(path) = &self.path else {
            return;
        };
        let written = serde_json::to_vec(saved)
            .map_err(std::io::Error::from)
            .and_then(|bytes| sikemux_process::files::write_atomic(path, &bytes, true));
        if let Err(error) = written {
            eprintln!("sikemux core: the app's projects and agents were not saved: {error}");
        }
    }

    fn set(&self, projects: Vec<ProjectInfo>, launchers: Vec<Launcher>) -> CoreResult<()> {
        if projects.len() > MAX_PROJECTS || launchers.len() > MAX_LAUNCHERS {
            return Err("the app published more projects or launchers than the core keeps".into());
        }
        if let Some(project) = projects.iter().find(|project| !project.path.is_absolute()) {
            return Err(format!("project {} has no absolute path", project.name).into());
        }
        let mut published = self.lock();
        published.saved.projects = projects;
        published.saved.launchers = launchers;
        self.save(&published.saved);
        Ok(())
    }

    /// A chat of `launcher` in `cwd`, built afresh, for an agent not yet named.
    /// Reads the providers' keys from the Keychain, so it blocks.
    fn chat_launch(&self, launcher: &Launcher, cwd: &Path) -> ChatLaunch {
        let agent = &launcher.agent;
        let providers = self
            .providers
            .as_ref()
            .map(|providers| providers.environment(&agent.provider))
            .unwrap_or_default();
        let skills = self.data_dir.as_deref().and_then(skills::ready);
        let built = agent.chat(launcher.program.clone(), providers, skills);
        ChatLaunch {
            agent_id: String::new(),
            provider: agent.provider.clone(),
            cwd: cwd.to_path_buf(),
            program: built.program,
            args: built.args,
            env: built.env,
            mcp_servers: Vec::new(),
            resume_id: None,
            permission_mode: launcher.permission_mode.clone(),
            model: None,
            effort: None,
            account: None,
            fallbacks: Vec::new(),
        }
    }

    fn project_path(&self, id: &str) -> CoreResult<PathBuf> {
        self.lock()
            .saved
            .projects
            .iter()
            .find(|project| project.id == id)
            .map(|project| project.path.clone())
            .ok_or_else(|| CoreError::from("that project is not open in Sikemux on this host"))
    }

    fn launcher(&self, id: &str) -> CoreResult<Launcher> {
        self.lock()
            .saved
            .launchers
            .iter()
            .find(|launcher| launcher.id == id)
            .cloned()
            .ok_or_else(|| {
                CoreError::from("that agent is not one Sikemux on this host can start; open Sikemux on the host once so it can say which it can")
            })
    }

    pub(crate) fn publish_backdrop(
        &self,
        texture: bool,
        image: Option<BackdropImage>,
    ) -> CoreResult<()> {
        if let Some(image) = &image {
            if !image.data_url.starts_with("data:image/") {
                return Err("the backdrop picture is not an image".into());
            }
            if image.data_url.len() > MAX_IMAGE_BYTES {
                return Err("the backdrop picture is larger than the core keeps".into());
            }
        }
        let mut published = self.lock();
        published.texture = texture;
        published.image = image;
        Ok(())
    }

    pub(crate) fn backdrop_image(&self) -> Option<String> {
        self.lock()
            .image
            .as_ref()
            .map(|image| image.data_url.clone())
    }

    pub(crate) fn publish_palette(&self, palette: BTreeMap<String, String>) -> CoreResult<()> {
        let oversized = palette
            .iter()
            .any(|(name, value)| name.len() > MAX_COLOUR_CHARS || value.len() > MAX_COLOUR_CHARS);
        if palette.len() > MAX_COLOURS || oversized {
            return Err("the app published more theme colours than the core keeps".into());
        }
        self.lock().palette = palette;
        Ok(())
    }

    pub(crate) fn publish_agents(
        &self,
        chats: Vec<PublishedChat>,
        titles: BTreeMap<String, String>,
    ) -> CoreResult<()> {
        let too_long = |title: &str| title.chars().count() > MAX_TITLE_CHARS;
        let chat_too_long = |chat: &PublishedChat| chat.title.as_deref().is_some_and(too_long);
        if chats.len() > MAX_CHATS
            || titles.len() > MAX_CHATS
            || chats.iter().any(chat_too_long)
            || titles.values().any(|title| too_long(title))
        {
            return Err("the app published more agents than the core keeps".into());
        }
        let mut published = self.lock();
        published.titles = titles;
        if published.saved.chats.as_ref() != Some(&chats) {
            published
                .saved
                .asleep
                .retain(|asleep| chats.iter().any(|chat| chat.agent_id == asleep.agent_id));
            published.saved.chats = Some(chats);
            self.save(&published.saved);
        }
        Ok(())
    }

    pub(crate) fn publish_runs(&self, runs: BTreeMap<String, AgentRun>) -> CoreResult<()> {
        let oversized = |run: &AgentRun| run.launcher.len() > 256 || run.permission_mode.len() > 64;
        if runs.values().any(oversized) {
            return Err(
                "the app said an agent runs with a launcher or mode longer than the core keeps"
                    .into(),
            );
        }
        self.lock().runs = runs;
        Ok(())
    }

    pub(crate) fn run_of(&self, agent_id: &str) -> Option<AgentRun> {
        self.lock().runs.get(agent_id).cloned()
    }

    pub(crate) fn publish_recent(&self, chats: Vec<PublishedRecent>) -> CoreResult<()> {
        let oversized = |chat: &PublishedRecent| {
            chat.title.chars().count() > MAX_TITLE_CHARS
                || chat.session_id.is_empty()
                || chat.session_id.chars().count() > MAX_SESSION_ID_CHARS
        };
        if chats.len() > MAX_RECENT || chats.iter().any(oversized) {
            return Err("the app published more recent chats than the core keeps".into());
        }
        let mut published = self.lock();
        if published.saved.recent != chats {
            published.saved.recent = chats;
            self.save(&published.saved);
        }
        Ok(())
    }

    /// The recent chats a device may take up again: those in a project the
    /// app has open, leaving out any running now.
    pub(crate) fn recent(&self, open: &[ChatInfo]) -> Vec<RecentInfo> {
        let published = self.lock();
        let saved = &published.saved;
        saved
            .recent
            .iter()
            .filter(|chat| !running_now(chat, open))
            .filter_map(|chat| {
                let project = saved
                    .projects
                    .iter()
                    .find(|project| project.path == chat.cwd)?;
                Some(RecentInfo {
                    id: recent_id(chat),
                    provider: chat.provider.clone(),
                    title: chat.title.clone(),
                    project: project.id.clone(),
                    cwd: chat.cwd.clone(),
                    active_at: chat.active_at,
                })
            })
            .collect()
    }

    /// How to start the recent chat a device chose, the way it would start a new one.
    fn resume_choice(&self, choice: ResumeChoice, open: &[ChatInfo]) -> CoreResult<ChatChoice> {
        let published = self.lock();
        let saved = &published.saved;
        let chat = saved
            .recent
            .iter()
            .find(|chat| recent_id(chat) == choice.recent)
            .ok_or_else(|| {
                CoreError::from(
                    "that chat is no longer among the recent ones in Sikemux on this host",
                )
            })?;
        if running_now(chat, open) {
            return Err("that chat is already open on this host".into());
        }
        let project = saved
            .projects
            .iter()
            .find(|project| project.path == chat.cwd)
            .ok_or_else(|| {
                CoreError::from("that chat's project is not open in Sikemux on this host")
            })?;
        let launcher = saved
            .launchers
            .iter()
            .find(|launcher| {
                launcher.id == chat.launcher && launcher.agent.provider == chat.provider
            })
            .ok_or_else(|| {
                CoreError::from("Sikemux on this host can no longer start that chat's agent")
            })?;
        Ok(ChatChoice {
            launcher: launcher.id.clone(),
            project: project.id.clone(),
            permission_mode: choice.permission_mode,
            model: choice.model,
            effort: choice.effort,
            resume_id: Some(chat.session_id.clone()),
        })
    }

    pub(crate) fn project_paths(&self) -> Vec<PathBuf> {
        self.lock()
            .saved
            .projects
            .iter()
            .map(|project| project.path.clone())
            .collect()
    }

    /// What the app calls an agent terminal.
    pub(crate) fn title(&self, agent_id: &str) -> Option<String> {
        self.lock().titles.get(agent_id).cloned()
    }

    /// Keeps the models and effort levels a provider's session offered, so a
    /// device choosing them before it starts one sees the same.
    pub(crate) fn note_config_options(&self, provider: &str, setup: &Value) {
        if let Some(options) = setup
            .get("configOptions")
            .filter(|options| options.is_array())
        {
            self.lock()
                .config_options
                .insert(provider.to_owned(), options.clone());
        }
    }

    /// The running chats under the app's names, which include the agent's own
    /// unless the person renamed the chat, then the app's chats that are not running.
    pub(crate) fn listed(&self, mut running: Vec<ChatInfo>) -> Vec<ChatInfo> {
        let published = self.lock();
        let chats = published.saved.chats.as_deref().unwrap_or_default();
        for chat in &mut running {
            let title = chats
                .iter()
                .find(|known| known.agent_id == chat.agent_id)
                .and_then(|known| known.title.clone());
            if title.is_some() {
                chat.title = title;
            }
        }
        let stopped: Vec<ChatInfo> = chats
            .iter()
            .filter(|chat| !running.iter().any(|live| live.agent_id == chat.agent_id))
            .map(|chat| ChatInfo {
                agent_id: chat.agent_id.clone(),
                name: None,
                provider: chat.provider.clone(),
                title: chat.title.clone(),
                cwd: chat.cwd.clone(),
                session_id: None,
                state: ChatState::Stopped,
                running: false,
                pending_permissions: Vec::new(),
                subagents: 0,
                tasks: 0,
                reconnecting: None,
                started_by: None,
                launcher: None,
                permission_mode: String::new(),
                model: None,
                effort: None,
                asleep: chat.asleep,
                unread: false,
                active_at: None,
                group: Default::default(),
                status: Default::default(),
                attention_rank: 0,
            })
            .collect();
        running.extend(stopped);
        running
    }

    /// Whether the app is known to have closed the chat.
    pub(crate) fn closed(&self, agent_id: &str) -> bool {
        self.lock()
            .saved
            .chats
            .as_ref()
            .is_some_and(|chats| !chats.iter().any(|chat| chat.agent_id == agent_id))
    }

    /// Whether the app has the chat open, and if so whether it is asleep.
    pub(crate) fn published(&self, agent_id: &str) -> Option<bool> {
        self.lock()
            .saved
            .chats
            .iter()
            .flatten()
            .find(|chat| chat.agent_id == agent_id)
            .map(|chat| chat.asleep)
    }

    pub(crate) fn view(&self) -> Workspace {
        let published = self.lock();
        Workspace {
            projects: published.saved.projects.clone(),
            launchers: published
                .saved
                .launchers
                .iter()
                .map(|launcher| {
                    let config_options = published
                        .config_options
                        .get(&launcher.agent.provider)
                        .cloned()
                        .unwrap_or(Value::Null);
                    let (model, effort) = pickers::pickers(&config_options);
                    LauncherInfo {
                        id: launcher.id.clone(),
                        provider: launcher.agent.provider.clone(),
                        label: launcher.label.clone(),
                        permission_mode: launcher.permission_mode.clone(),
                        config_options,
                        status: launcher.status.clone(),
                        model,
                        effort,
                    }
                })
                .collect(),
            palette: published.palette.clone(),
            backdrop: Backdrop {
                texture: published.texture,
                image: published.image.as_ref().map(|image| image.id.clone()),
            },
        }
    }
}

/// How a lead runs, for an agent it starts to run the same way.
pub(crate) struct Lead {
    pub provider: String,
    /// Its launch, when it is a chat the core runs.
    pub launch: Option<ChatLaunch>,
    pub launcher: Option<String>,
    pub permission_mode: Option<String>,
}

impl Lead {
    /// The permission mode a worker of the lead running `provider` takes, never
    /// wider than the lead's, given `default` when the lead's is unknown.
    pub(crate) fn worker_mode(&self, provider: &str, default: &str) -> String {
        match self.permission_mode.as_deref() {
            Some(mode) if self.provider == provider => mode.to_owned(),
            Some("bypass") => "bypass".to_owned(),
            Some(_) => "workspace-write".to_owned(),
            None if matches!(default, "bypass" | "full-access") => "workspace-write".to_owned(),
            None => default.to_owned(),
        }
    }
}

/// Agents whose chats keep a private home of their own, which a worker of
/// theirs must not share.
const OWN_HOME: [&str; 2] = ["hermes", "grok"];

impl Workspaces {
    /// How to start an agent of `provider` for `lead` in `cwd`: on the lead's
    /// account and in its permission mode. The lead may pick the model.
    pub(crate) fn worker_launch(
        &self,
        lead: &Lead,
        provider: &str,
        cwd: &Path,
        model: Option<String>,
    ) -> Result<(ChatLaunch, Option<String>), String> {
        let same = lead.provider == provider;
        let mode = |default: &str| lead.worker_mode(provider, default);
        let own = lead
            .launch
            .as_ref()
            .filter(|_| same && !OWN_HOME.contains(&provider));
        if let Some(own) = own {
            let mut launch = own.clone();
            launch.cwd = cwd.to_path_buf();
            launch.resume_id = None;
            launch.permission_mode = mode(&own.permission_mode);
            launch.model = model.or(launch.model);
            return Ok((launch, lead.launcher.clone()));
        }
        let launcher = {
            let published = self.lock();
            let launchers = &published.saved.launchers;
            let offered: Vec<&Launcher> = launchers
                .iter()
                .filter(|launcher| launcher.agent.provider == provider)
                .collect();
            let lead_own = offered
                .iter()
                .find(|launcher| Some(&launcher.id) == lead.launcher.as_ref());
            if same && lead_own.is_none() && offered.len() > 1 {
                return Err(format!(
                    "Sikemux cannot tell which {provider} account you run on, so it will not start one on another; pick another cli or ask the person to start it"
                ));
            }
            let launcher = lead_own.or_else(|| offered.first()).ok_or_else(|| {
                let known: Vec<&str> = launchers
                    .iter()
                    .map(|launcher| launcher.agent.provider.as_str())
                    .collect();
                if known.is_empty() {
                    "Sikemux has not said which agents it can start; open Sikemux once so it can"
                        .to_owned()
                } else {
                    format!("cli must be one of {}", known.join(", "))
                }
            })?;
            (*launcher).clone()
        };
        match launcher.status.as_deref() {
            Some("missing") => {
                return Err(format!("{} is not installed on this host", launcher.label))
            }
            Some("signedOut") => {
                return Err(format!(
                    "{} is signed out on this host; ask the person to sign in",
                    launcher.label
                ))
            }
            Some("broken") => {
                return Err(format!("{} does not start on this host", launcher.label))
            }
            _ => {}
        }
        let mut launch = self.chat_launch(&launcher, cwd);
        launch.permission_mode = mode(&launcher.permission_mode);
        match lead.launch.as_ref().filter(|_| same) {
            Some(own) => {
                launch.account = own.account.clone();
                launch.fallbacks = own.fallbacks.clone();
                launch.model = model.or_else(|| own.model.clone());
            }
            None => launch.model = model,
        }
        Ok((launch, Some(launcher.id)))
    }
}

impl Workspaces {
    pub(crate) fn has_launchers(&self) -> bool {
        !self.lock().saved.launchers.is_empty()
    }

    /// How Auto starts an agent of its own in `cwd`: with the launcher the
    /// project names, else the first the app offers that works, in that
    /// launcher's own permission mode. Reads the Keychain, so it blocks.
    pub(crate) fn auto_launch(
        &self,
        launcher: Option<&str>,
        cwd: &Path,
        model: Option<String>,
    ) -> Result<(ChatLaunch, String), String> {
        let chosen = {
            let published = self.lock();
            let launchers = &published.saved.launchers;
            let usable = |launcher: &&Launcher| {
                !matches!(
                    launcher.status.as_deref(),
                    Some("missing" | "signedOut" | "broken")
                )
            };
            match launcher {
                Some(id) => launchers
                    .iter()
                    .find(|launcher| launcher.id == id)
                    .ok_or_else(|| {
                        format!("Sikemux can no longer start {id}; pick another agent in the board's Auto settings")
                    })?,
                None => launchers.iter().find(usable).ok_or(
                    "Sikemux has not said which agents it can start; open Sikemux once so it can",
                )?,
            }
            .clone()
        };
        match chosen.status.as_deref() {
            Some("missing") => return Err(format!("{} is not installed", chosen.label)),
            Some("signedOut") => return Err(format!("{} is signed out", chosen.label)),
            Some("broken") => return Err(format!("{} does not start", chosen.label)),
            _ => {}
        }
        let mut launch = self.chat_launch(&chosen, cwd);
        launch.model = model;
        Ok((launch, chosen.id))
    }

    /// Keeps how the agent's chat runs as it stops, so a device can wake it
    /// when the app is not there to.
    pub(crate) fn note_stopping(&self, chat: &chat::Chat) {
        let agent_id = chat.agent_id();
        let Some(launcher) = chat
            .origin
            .launcher
            .clone()
            .or_else(|| self.run_of(agent_id).map(|run| run.launcher))
        else {
            return;
        };
        let launch = chat.current_now();
        let mut published = self.lock();
        let asleep = &mut published.saved.asleep;
        asleep.retain(|asleep| asleep.agent_id != agent_id);
        if asleep.len() >= MAX_CHATS {
            asleep.remove(0);
        }
        asleep.push(Asleep {
            agent_id: agent_id.to_owned(),
            launcher,
            cwd: launch.cwd,
            resume_id: launch.resume_id,
            permission_mode: launch.permission_mode,
            model: launch.model,
            effort: launch.effort,
            account: launch.account,
            fallbacks: launch.fallbacks,
        });
        self.save(&published.saved);
    }

    fn take_asleep(&self, agent_id: &str) -> Option<Asleep> {
        let mut published = self.lock();
        let asleep = &mut published.saved.asleep;
        let index = asleep
            .iter()
            .position(|asleep| asleep.agent_id == agent_id)?;
        let taken = asleep.remove(index);
        self.save(&published.saved);
        Some(taken)
    }
}

/// Gives `launch` to `agent_id`, with the secret and tools that are its own.
pub(crate) fn own_launch(core: &Core, launch: &mut ChatLaunch, agent_id: &str) {
    let secret = core.agent_key.secret(agent_id);
    launch.agent_id = agent_id.to_owned();
    launch.mcp_servers = cli_endpoint(core)
        .and_then(|endpoint| tools_server(agent_id, &secret, &endpoint))
        .into_iter()
        .collect();
    launch
        .env
        .insert("SIKEMUX_AGENT_ID".into(), agent_id.to_owned());
    launch.env.insert("SIKEMUX_AGENT_SECRET".into(), secret);
}

/// The agents' own tools, served by this binary run as an MCP server, the
/// same way the app wires them into a chat it starts.
fn tools_server(agent_id: &str, secret: &str, endpoint: &Path) -> Option<Value> {
    let executable = std::env::current_exe().ok()?;
    let mut server = McpServerStdio::new("sikemux-tools", executable);
    server.args = vec!["--tools-mcp".into()];
    server.env = vec![
        EnvVariable::new("SIKEMUX_TOOLS_AGENT_ID", agent_id),
        EnvVariable::new("SIKEMUX_AGENT_SECRET", secret),
        EnvVariable::new("SIKEMUX_CLI_ENDPOINT", endpoint.to_string_lossy()),
    ];
    serde_json::to_value(McpServer::Stdio(server)).ok()
}

fn cli_endpoint(core: &Core) -> Option<PathBuf> {
    core.listening.get()?.config.cli_endpoint.clone()
}

fn running(core: &Core, agent_id: &str) -> bool {
    core.chats
        .list()
        .iter()
        .any(|chat| chat.agent_id == agent_id)
}

#[derive(Deserialize)]
pub(crate) struct WorkspaceParams {
    projects: Vec<ProjectInfo>,
    launchers: Vec<Launcher>,
}

/// Keeps the projects the app has open and the agents it offers, each with
/// the program the core finds for it. An agent with none is left out.
pub(crate) async fn set_workspace(core: &Arc<Core>, params: WorkspaceParams) -> CoreResult<()> {
    if params.launchers.len() > MAX_LAUNCHERS {
        return Err("the app published more projects or launchers than the core keeps".into());
    }
    let asked = core.workspaces.asked.fetch_add(1, Ordering::SeqCst) + 1;
    let finding: Vec<_> = params
        .launchers
        .into_iter()
        .map(|launcher| {
            tokio::spawn(async move {
                let program = launcher.agent.program().await.ok()?;
                Some(Launcher {
                    program,
                    ..launcher
                })
            })
        })
        .collect();
    let mut launchers = Vec::with_capacity(finding.len());
    for found in finding {
        launchers.extend(found.await.ok().flatten());
    }
    if core.workspaces.asked.load(Ordering::SeqCst) != asked {
        return Ok(());
    }
    core.workspaces.set(params.projects, launchers)
}

/// A chat of the app's `launcher` in `cwd`, built afresh off the async threads.
async fn built(core: &Arc<Core>, launcher: &str, cwd: PathBuf) -> CoreResult<(ChatLaunch, String)> {
    let launcher = core.workspaces.launcher(launcher)?;
    let core = core.clone();
    blocking(move || {
        let launch = core.workspaces.chat_launch(&launcher, &cwd);
        Ok((launch, launcher.id))
    })
    .await
}

/// Starts a chat for `by`, a device the app leaves it running for when it opens.
fn begin(
    core: &Arc<Core>,
    by: Option<&Arc<ClientConn>>,
    mut launch: ChatLaunch,
    agent_id: &str,
    launcher: String,
) -> CoreResult<Arc<chat::Chat>> {
    own_launch(core, &mut launch, agent_id);
    let started = chat::begin(core, launch, by, Some(launcher))?;
    core.broadcast_local(&Event::ChatBegun {
        chat: started.info(),
    });
    Ok(started)
}

/// Wakes a chat the app put to sleep and answers once it is ready, so a
/// device taking it up next finds it there. The app wakes it when its
/// window is open; otherwise the core starts it on its saved conversation.
pub(crate) async fn wake_chat(
    core: &Arc<Core>,
    by: Option<&Arc<ClientConn>>,
    agent_id: String,
) -> CoreResult<Response> {
    let deadline = tokio::time::Instant::now() + WAKE_WAIT;
    if !running(core, &agent_id) {
        match core.workspaces.published(&agent_id) {
            None => return Err("that chat is no longer open in Sikemux on this host".into()),
            Some(false) => {
                return Err(
                    "this chat stopped on the host; open it in Sikemux there to start it again"
                        .into(),
                )
            }
            Some(true) => {}
        }
        if core.window.is_open() {
            core.broadcast_local(&Event::WakeChat {
                agent_id: agent_id.clone(),
            });
            while !running(core, &agent_id) {
                if tokio::time::Instant::now() >= deadline {
                    return Err(DID_NOT_WAKE.into());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        } else {
            wake_here(core, by, &agent_id).await?;
        }
    }
    tokio::time::timeout_at(deadline, chat::until_ready(core, &agent_id))
        .await
        .map_err(|_| CoreError::from(DID_NOT_WAKE))??;
    Ok(Response::Done)
}

const DID_NOT_WAKE: &str = "the chat did not wake; open it in Sikemux on the host";

async fn wake_here(
    core: &Arc<Core>,
    by: Option<&Arc<ClientConn>>,
    agent_id: &str,
) -> CoreResult<()> {
    let asleep = core.workspaces.take_asleep(agent_id).ok_or_else(|| {
        CoreError::from(
            "Sikemux on this host does not know how this chat ran; open it there to wake it",
        )
    })?;
    let (mut launch, launcher) = built(core, &asleep.launcher, asleep.cwd).await?;
    launch.resume_id = asleep.resume_id;
    launch.permission_mode = asleep.permission_mode;
    launch.model = asleep.model;
    launch.effort = asleep.effort;
    launch.account = asleep.account;
    launch.fallbacks = asleep.fallbacks;
    begin(core, by, launch, agent_id, launcher)?;
    Ok(())
}

/// Starts the chat and answers `client` once its session is ready.
pub(crate) fn start_chat(
    core: &Arc<Core>,
    client: &Arc<ClientConn>,
    request_id: RequestId,
    choice: ChatChoice,
) {
    let (core, client) = (core.clone(), client.clone());
    tokio::spawn(async move {
        let result = start(&core, &client, choice).await;
        client.respond(request_id, result);
    });
}

async fn start(
    core: &Arc<Core>,
    client: &Arc<ClientConn>,
    choice: ChatChoice,
) -> CoreResult<Response> {
    let cwd = core.workspaces.project_path(&choice.project)?;
    let (mut launch, launcher) = built(core, &choice.launcher, cwd).await?;
    launch.resume_id = choice.resume_id;
    if let Some(mode) = choice.permission_mode {
        launch.permission_mode = mode;
    }
    launch.model = choice.model;
    launch.effort = choice.effort;
    let agent_id = format!("agent-{}", uuid::Uuid::new_v4().simple());
    let started = begin(core, Some(client), launch, &agent_id, launcher)?;
    let start = chat::until_started(core, started).await?;
    Ok(Response::ChatBegun { agent_id, start })
}

/// Takes up a recent chat again, answering like [`start_chat`].
pub(crate) fn resume_chat(
    core: &Arc<Core>,
    client: &Arc<ClientConn>,
    request_id: RequestId,
    choice: ResumeChoice,
) {
    match core.workspaces.resume_choice(choice, &core.chats.list()) {
        Ok(choice) => start_chat(core, client, request_id, choice),
        Err(error) => client.respond(request_id, Err(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launcher() -> Launcher {
        Launcher {
            id: "claude:work".into(),
            label: "Claude Code (work)".into(),
            agent: AgentSpec {
                config_path: Some("/Users/me/.claude-work".into()),
                ..AgentSpec::new("claude")
            },
            permission_mode: "bypass".into(),
            status: None,
            program: "/usr/local/bin/claude".into(),
        }
    }

    fn launch(workspaces: &Workspaces, choice: ChatChoice) -> CoreResult<ChatLaunch> {
        let launcher = workspaces.launcher(&choice.launcher)?;
        let cwd = workspaces.project_path(&choice.project)?;
        let mut launch = workspaces.chat_launch(&launcher, &cwd);
        launch.resume_id = choice.resume_id;
        launch.model = choice.model;
        Ok(launch)
    }

    fn project() -> ProjectInfo {
        ProjectInfo {
            id: "sess-1".into(),
            name: "sikemux".into(),
            path: "/Users/me/sikemux".into(),
        }
    }

    fn choice() -> ChatChoice {
        ChatChoice {
            launcher: "claude:work".into(),
            project: "sess-1".into(),
            permission_mode: None,
            model: Some("opus".into()),
            effort: None,
            resume_id: None,
        }
    }

    fn recent(session_id: &str, cwd: &str) -> PublishedRecent {
        PublishedRecent {
            launcher: "claude:work".into(),
            provider: "claude".into(),
            session_id: session_id.into(),
            title: "Fix the login flake".into(),
            cwd: cwd.into(),
            active_at: 1_000,
        }
    }

    fn resuming(recent: &str) -> ResumeChoice {
        ResumeChoice {
            recent: recent.into(),
            permission_mode: None,
            model: None,
            effort: None,
        }
    }

    #[test]
    fn a_device_sees_launchers_without_their_program_or_environment() {
        let workspaces = Workspaces::new(None);
        workspaces.set(vec![project()], vec![launcher()]).unwrap();
        let shown = serde_json::to_string(&workspaces.view()).unwrap();
        assert!(shown.contains("Claude Code (work)"));
        assert!(!shown.contains("/usr/local/bin/claude"));
        assert!(!shown.contains(".claude-work"));
    }

    #[test]
    fn a_device_sees_whether_each_launcher_is_signed_in() {
        let workspaces = Workspaces::new(None);
        let signed_out = Launcher {
            status: Some("signedOut".into()),
            ..launcher()
        };
        workspaces.set(vec![project()], vec![signed_out]).unwrap();
        let view = workspaces.view();
        assert_eq!(view.launchers[0].status.as_deref(), Some("signedOut"));
        workspaces.set(vec![project()], vec![launcher()]).unwrap();
        let shown = serde_json::to_value(workspaces.view()).unwrap();
        assert!(shown["launchers"][0].get("status").is_none());
    }

    #[test]
    fn a_chat_starts_in_the_project_with_the_launcher_and_its_account() {
        let workspaces = Workspaces::new(None);
        workspaces.set(vec![project()], vec![launcher()]).unwrap();
        let launch = launch(&workspaces, choice()).unwrap();
        assert_eq!(launch.cwd, PathBuf::from("/Users/me/sikemux"));
        assert_eq!(launch.program, PathBuf::from("/usr/local/bin/claude"));
        assert_eq!(launch.permission_mode, "bypass");
        assert_eq!(launch.model.as_deref(), Some("opus"));
        assert_eq!(
            launch.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some("/Users/me/.claude-work")
        );
    }

    #[test]
    fn an_unknown_launcher_or_project_is_refused() {
        let workspaces = Workspaces::new(None);
        workspaces.set(vec![project()], vec![launcher()]).unwrap();
        let mut wrong = choice();
        wrong.project = "elsewhere".into();
        assert!(launch(&workspaces, wrong).is_err());
        let mut wrong = choice();
        wrong.launcher = "gemini".into();
        assert!(launch(&workspaces, wrong).is_err());
    }

    #[test]
    fn a_device_sees_recent_chats_in_open_projects_but_not_running_ones() {
        let workspaces = Workspaces::new(None);
        workspaces.set(vec![project()], vec![launcher()]).unwrap();
        workspaces
            .publish_recent(vec![
                recent("s1", "/Users/me/sikemux"),
                recent("s2", "/Users/me/sikemux"),
                recent("s3", "/Users/me/closed"),
            ])
            .unwrap();
        let running = workspaces.listed(Vec::new());
        let shown = workspaces.recent(&running);
        assert_eq!(
            shown
                .iter()
                .map(|chat| chat.id.as_str())
                .collect::<Vec<_>>(),
            ["claude:s1", "claude:s2"]
        );
        assert_eq!(shown[0].project, "sess-1");
        assert!(!serde_json::to_string(&shown)
            .unwrap()
            .contains("claude:work"));

        let mut live = ChatInfo {
            agent_id: "agent-1".into(),
            name: None,
            provider: "claude".into(),
            title: None,
            cwd: "/Users/me/sikemux".into(),
            session_id: Some("s1".into()),
            state: ChatState::Ready,
            running: false,
            pending_permissions: Vec::new(),
            subagents: 0,
            tasks: 0,
            reconnecting: None,
            started_by: None,
            launcher: None,
            permission_mode: String::new(),
            model: None,
            effort: None,
            asleep: false,
            unread: false,
            active_at: None,
            group: Default::default(),
            status: Default::default(),
            attention_rank: 0,
        };
        assert_eq!(workspaces.recent(std::slice::from_ref(&live)).len(), 1);
        live.provider = "codex".into();
        assert_eq!(workspaces.recent(&[live]).len(), 2);
    }

    #[test]
    fn a_recent_chat_resumes_with_its_launcher_in_its_project() {
        let workspaces = Workspaces::new(None);
        workspaces.set(vec![project()], vec![launcher()]).unwrap();
        workspaces
            .publish_recent(vec![recent("s1", "/Users/me/sikemux")])
            .unwrap();
        let choice = workspaces
            .resume_choice(resuming("claude:s1"), &[])
            .unwrap();
        let launch = launch(&workspaces, choice).unwrap();
        assert_eq!(launch.resume_id.as_deref(), Some("s1"));
        assert_eq!(launch.cwd, PathBuf::from("/Users/me/sikemux"));
        assert_eq!(launch.provider, "claude");
        assert_eq!(launch.permission_mode, "bypass");
    }

    #[test]
    fn only_a_published_recent_chat_resumes() {
        let workspaces = Workspaces::new(None);
        workspaces.set(vec![project()], vec![launcher()]).unwrap();
        workspaces
            .publish_recent(vec![recent("s1", "/Users/me/sikemux")])
            .unwrap();
        assert!(workspaces
            .resume_choice(resuming("claude:other"), &[])
            .is_err());
        assert!(workspaces.resume_choice(resuming("s1"), &[]).is_err());
        workspaces.publish_recent(Vec::new()).unwrap();
        assert!(workspaces
            .resume_choice(resuming("claude:s1"), &[])
            .is_err());
        let mut elsewhere = recent("s2", "/Users/me/sikemux");
        elsewhere.launcher = "codex".into();
        workspaces.publish_recent(vec![elsewhere]).unwrap();
        assert!(workspaces
            .resume_choice(resuming("claude:s2"), &[])
            .is_err());
    }

    #[test]
    fn a_relative_project_path_is_refused() {
        let workspaces = Workspaces::new(None);
        let mut relative = project();
        relative.path = "sikemux".into();
        assert!(workspaces.set(vec![relative], Vec::new()).is_err());
    }
}
