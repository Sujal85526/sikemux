//! The chat agents the core starts and speaks to: Claude Code over its
//! stream-json control protocol, Codex over its app server, Muse Code over its
//! session protocol, and every other agent over ACP. Each tells the chat the
//! same ACP-shaped session updates, so the app reads them alike.

mod acp;
mod claude;
mod codex;
mod json;
mod muse;
mod patch;
mod process;
mod rpc;
mod session;

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::protocol::ChatLaunch;

use super::rebind::{Outcome, Rebind};
use super::{Chat, ChatCommand};

/// What a client rebuilding a chat needs to tell its turns apart: when a
/// replayed update first happened, in Unix milliseconds, and whether it began
/// a turn the agent started by itself.
fn stamp_replayed(update: &mut Value, at: Option<u64>, opens_turn: bool) {
    let Some(fields) = update
        .as_object_mut()
        .filter(|_| at.is_some() || opens_turn)
    else {
        return;
    };
    let meta = fields.entry("_meta").or_insert_with(|| json!({}));
    let Some(sikemux) = meta
        .as_object_mut()
        .map(|meta| meta.entry("sikemux").or_insert_with(|| json!({})))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    if let Some(at) = at {
        sikemux.insert("at".into(), json!(at));
    }
    if opens_turn {
        sikemux.insert("opensTurn".into(), json!(true));
    }
}

/// How an agent is shown a file the person attached: a markdown link named
/// for the file, the way the agents' own clients write it.
fn file_link(name: Option<&str>, uri: &str) -> String {
    match name.filter(|name| !name.is_empty()) {
        Some(name) => format!("[@{name}]({uri})"),
        None => match uri.strip_prefix("file://") {
            Some(path) => format!("[@{}]({uri})", path.rsplit('/').next().unwrap_or(path)),
            None => uri.to_owned(),
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Claude,
    Codex,
    Muse,
    Acp,
}

impl Kind {
    pub fn of(provider: &str) -> Self {
        match provider {
            "claude" => Self::Claude,
            "codex" => Self::Codex,
            "muse" => Self::Muse,
            _ => Self::Acp,
        }
    }
}

pub(super) async fn run(
    kind: Kind,
    chat: Arc<Chat>,
    launch: ChatLaunch,
    commands: &mut mpsc::UnboundedReceiver<ChatCommand>,
    rebind: Option<Box<Rebind>>,
) -> Result<Outcome, String> {
    match kind {
        Kind::Claude => session::run::<claude::Claude>(chat, launch, commands, rebind).await,
        Kind::Codex => session::run::<codex::Codex>(chat, launch, commands, rebind).await,
        Kind::Muse => session::run::<muse::Muse>(chat, launch, commands, rebind).await,
        Kind::Acp => session::run::<acp::Acp>(chat, launch, commands, rebind).await,
    }
}
