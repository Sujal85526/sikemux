//! The person's accounts with their agents, which the core keeps so a host
//! with no app still knows them. A profile names an agent, the folder its CLI
//! keeps one sign-in in, and optionally its program and which of the person's
//! variables it gets. Signing in runs the agent's own login; Sikemux never
//! reads or stores a credential.

pub mod folders;
pub mod status;
pub mod usage;

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sikemux_pty::user_shell::login_shell_environment;
use tokio::process::Command;

use crate::launch::AgentSpec;

const MAX_PROFILES: usize = 64;
const MAX_TEXT: usize = 4_096;

/// One account with one agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub accent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    /// The account folder, or a config file in it; the agent's default when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environment_keys: Vec<String>,
}

impl Profile {
    pub fn spec(&self) -> AgentSpec {
        AgentSpec {
            provider: self.provider.clone(),
            executable_path: self.executable_path.clone(),
            config_path: self.config_path.clone(),
            environment_keys: self.environment_keys.clone(),
        }
    }
}

/// Every profile, and which one each agent starts on, by provider.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub selected: BTreeMap<String, String>,
}

impl Book {
    pub fn check(&self) -> Result<(), String> {
        let long = |text: &str| text.len() > MAX_TEXT;
        let oversized = self.profiles.iter().any(|profile| {
            [
                &profile.id,
                &profile.name,
                &profile.provider,
                &profile.accent,
            ]
            .into_iter()
            .chain(profile.executable_path.as_ref())
            .chain(profile.config_path.as_ref())
            .chain(&profile.environment_keys)
            .any(|text| long(text))
                || profile.environment_keys.len() > 64
        });
        let selected = |(provider, id): (&String, &String)| long(provider) || long(id);
        let oversized = oversized || self.selected.iter().any(selected);
        if self.profiles.len() > MAX_PROFILES || oversized || self.selected.len() > MAX_PROFILES {
            return Err("the app sent more agent accounts than the core keeps".into());
        }
        Ok(())
    }

    /// The agent `provider` on the account in `config_path`.
    pub fn spec(&self, provider: &str, config_path: Option<&str>) -> AgentSpec {
        self.profiles
            .iter()
            .find(|profile| {
                profile.provider == provider && profile.config_path.as_deref() == config_path
            })
            .map(Profile::spec)
            .unwrap_or_else(|| AgentSpec {
                config_path: config_path.map(str::to_owned),
                ..AgentSpec::new(provider)
            })
    }
}

/// One account, as a call names it.
fn key(provider: &str, config_path: Option<&str>) -> String {
    format!("{provider}\0{}", config_path.unwrap_or(""))
}

/// `program` run as `provider` on the account in `config_path`, with the
/// person's shell variables, for a one-off question to its CLI.
pub fn cli(
    provider: &str,
    program: &Path,
    config_path: Option<&str>,
    providers: BTreeMap<String, String>,
) -> Command {
    let spec = AgentSpec {
        config_path: config_path.map(str::to_owned),
        ..AgentSpec::new(provider)
    };
    let mut command = Command::from(sikemux_process::user_environment::command(program));
    command
        .envs(login_shell_environment())
        .envs(spec.launch(program.to_path_buf(), providers).env)
        .kill_on_drop(true);
    command
}

/// The core's calls about accounts, all of them the app's own.
pub const METHODS: [&str; 8] = [
    "agentAccounts",
    "setAgentAccounts",
    "addAgentAccount",
    "agentStatus",
    "agentAccountStatus",
    "agentUsage",
    "forgetAgentStatus",
    "markAgentSignedOut",
];
