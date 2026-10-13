//! The core's methods a client reaches by name through `Request::Call`. A
//! device gains a method here without its native code changing, so one a
//! released app calls is never removed or renamed.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::access::{Needs, Peer};
use super::attachments;
use super::connection::blocking;
use super::names::AgentName;
use super::{share, Core, CoreError, CoreResult};

pub(crate) fn needs(method: &str) -> Needs {
    match method {
        "chatFile" => Needs::Watch,
        _ => Needs::Local,
    }
}

pub(crate) async fn call(
    core: Arc<Core>,
    peer: &Peer,
    method: &str,
    params: Value,
) -> CoreResult<Value> {
    match method {
        "chatFile" => answer(chat_file(&core, peer, parse(params)?).await?),
        "agentSecret" => answer(agent_secret(&core, parse(params)?)?),
        "nameAgent" => answer(name_agent(&core, parse(params)?).await?),
        "renameAgent" => answer(rename_agent(&core, parse(params)?)?),
        "shareChat" => {
            let params: ShareChatParams = parse(params)?;
            answer(share::share_chat(
                &core,
                &params.agent_id,
                params.lifetime_ms,
                params.title,
            )?)
        }
        "stopShare" => {
            let params: StopShareParams = parse(params)?;
            answer(share::stop(&core, &params.id)?)
        }
        "shares" => answer(share::list(&core)),
        _ => Err(format!("this host does not know {method}").into()),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> CoreResult<T> {
    serde_json::from_value(params)
        .map_err(|error| CoreError::from(format!("the call's params do not fit: {error}")))
}

fn answer(result: impl Serialize) -> CoreResult<Value> {
    Ok(serde_json::to_value(result)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareChatParams {
    agent_id: String,
    lifetime_ms: u64,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Deserialize)]
struct StopShareParams {
    id: String,
}

#[derive(Deserialize)]
struct ChatFileParams {
    path: PathBuf,
}

#[derive(Serialize)]
struct ChatFile {
    data: String,
}

/// A file a chat's message carried, in base64. Any device may read the
/// pictures pasted into chats; one that can drive sessions can already read
/// anything through a terminal, so it may read files dropped from elsewhere.
async fn chat_file(core: &Core, peer: &Peer, params: ChatFileParams) -> CoreResult<ChatFile> {
    let pasted = core
        .listening
        .get()
        .and_then(|listening| listening.config.attachment_dir.clone());
    let path = params.path;
    let kept = match pasted {
        Some(dir) => {
            let path = path.clone();
            blocking(move || Ok(attachments::is_kept(&dir, &path))).await?
        }
        None => false,
    };
    if !kept {
        core.permit(peer, Needs::Full).map_err(|_| {
            CoreError::from("this device can open only the pictures pasted into chats")
        })?;
    }
    let data = blocking(move || attachments::read(&path)).await?;
    Ok(ChatFile { data })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSecretParams {
    agent_id: String,
}

#[derive(Serialize)]
struct AgentSecret {
    secret: String,
}

/// What an agent the app starts carries in its tool calls to show which agent
/// it is. Only a client on this machine may ask.
fn agent_secret(core: &Core, params: AgentSecretParams) -> CoreResult<AgentSecret> {
    if !crate::cli::protocol::is_tool_agent_id(&params.agent_id) {
        return Err("that is not an agent id".into());
    }
    Ok(AgentSecret {
        secret: core.agent_key.secret(&params.agent_id),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameAgentParams {
    agent_id: String,
    cwd: PathBuf,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    resume_id: Option<String>,
}

/// The name the core gave an agent the app starts or opens again, given now
/// when it has none.
async fn name_agent(core: &Arc<Core>, params: NameAgentParams) -> CoreResult<AgentName> {
    if !crate::cli::protocol::is_tool_agent_id(&params.agent_id) {
        return Err("that is not an agent id".into());
    }
    if !params.cwd.is_absolute() {
        return Err("an agent's folder must be an absolute path".into());
    }
    let core = core.clone();
    let named = blocking(move || {
        Ok(core.name_agent(
            &params.agent_id,
            &params.cwd,
            params.provider.as_deref(),
            params.resume_id.as_deref(),
        ))
    })
    .await?;
    Ok(named)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameAgentParams {
    agent_id: String,
    name: String,
}

fn rename_agent(core: &Core, params: RenameAgentParams) -> CoreResult<AgentName> {
    let named = core
        .names
        .rename(&params.agent_id, &params.name, &core.open_agents())?;
    core.publish_device_view();
    Ok(named)
}
