//! The core's methods a client reaches by name through `Request::Call`. A
//! device gains a method here without its native code changing, so one a
//! released app calls is never removed or renamed.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::access::{Needs, Peer};
use super::attachments;
use super::connection::{blocking, ClientConn};
use super::names::AgentName;
use super::workspace::AgentRun;
use super::{questions, share, Core, CoreError, CoreResult};

pub(crate) fn needs(method: &str) -> Needs {
    match method {
        "chatFile" | "questions" => Needs::Watch,
        "answerQuestion" => Needs::Full,
        _ => Needs::Local,
    }
}

pub(crate) async fn call(
    core: Arc<Core>,
    client: &ClientConn,
    method: &str,
    params: Value,
) -> CoreResult<Value> {
    match method {
        "chatFile" => answer(chat_file(&core, &client.peer, parse(params)?).await?),
        "agentSecret" => answer(agent_secret(&core, client, parse(params)?)?),
        "nameAgent" => answer(name_agent(&core, parse(params)?).await?),
        "renameAgent" => answer(rename_agent(&core, parse(params)?).await?),
        "agentsInApp" => answer(agents_in_app(&core, parse(params)?).await?),
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
        "questions" => answer(questions::views(&core)),
        "answerQuestion" => answer(questions::answer(&core, parse(params)?).await?),
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
/// it is. Only the app's window may ask, so one agent cannot ask for
/// another's.
fn agent_secret(
    core: &Core,
    client: &ClientConn,
    params: AgentSecretParams,
) -> CoreResult<AgentSecret> {
    if !core.window.is_window(client.id) {
        return Err("only Sikemux's window may ask for an agent's secret".into());
    }
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

async fn rename_agent(core: &Arc<Core>, params: RenameAgentParams) -> CoreResult<AgentName> {
    let core = core.clone();
    blocking(move || {
        let named = core
            .names
            .rename(&params.agent_id, &params.name, core.running_agents())?;
        core.publish_device_view();
        Ok(named)
    })
    .await
}

/// The most agents the app may say it holds.
const MAX_AGENTS_IN_APP: usize = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentsInAppParams {
    agent_ids: HashSet<String>,
    runs: BTreeMap<String, AgentRun>,
}

/// Every agent the app holds, sleeping ones included, so their names stay
/// theirs while nothing of them runs here.
async fn agents_in_app(core: &Arc<Core>, params: AgentsInAppParams) -> CoreResult<()> {
    if params.agent_ids.len() > MAX_AGENTS_IN_APP || params.runs.len() > MAX_AGENTS_IN_APP {
        return Err("the app named more agents than the core keeps".into());
    }
    if !params
        .agent_ids
        .iter()
        .all(|id| crate::cli::protocol::is_tool_agent_id(id))
    {
        return Err("that is not an agent id".into());
    }
    core.workspaces.publish_runs(params.runs)?;
    let core = core.clone();
    blocking(move || {
        core.names.set_in_app(params.agent_ids);
        Ok(())
    })
    .await
}
