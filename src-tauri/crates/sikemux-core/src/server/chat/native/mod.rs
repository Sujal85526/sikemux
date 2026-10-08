//! Agents the core speaks to in their own protocol rather than ACP: Claude
//! Code over its stream-json control protocol and Codex over its app server.
//! Both tell the chat the same ACP-shaped session updates every other agent
//! does, so the app reads them alike.

mod claude;
mod codex;
mod process;
mod rpc;
mod session;

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::protocol::ChatLaunch;

use super::rebind::{Outcome, Rebind};
use super::{Chat, ChatCommand};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Claude,
    Codex,
}

impl Kind {
    pub fn of(provider: &str) -> Option<Self> {
        match provider {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
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
    }
}
