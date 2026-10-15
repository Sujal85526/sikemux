//! The footer of a commit agents made: one line per agent whose changes it
//! holds, then the host's signature over them.
//!
//! ```text
//! Agent: Otter (claude, opus, chat 0199…, host 7f3a9c21d0e4b5a6)
//! Agent-Signature: <ed25519 signature in base64>
//! ```
//!
//! The name, cli and model only say what the agent was called. The chat and
//! the host are what a reader can check: the host signs them with the commit's
//! tree and parents, so a footer written by hand or copied onto another commit
//! does not check out.

use base64::engine::general_purpose::STANDARD_NO_PAD as BASE64;
use base64::Engine;
use iroh::{PublicKey, SecretKey, Signature};

const AGENT: &str = "Agent: ";
const SIGNATURE: &str = "Agent-Signature: ";
/// How much of the host's key an agent line shows, enough to pick it out of
/// the hosts a reader knows.
const HOST_CHARS: usize = 16;
const SCISSORS: &str = " ------------------------ >8 ------------------------";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    pub name: String,
    pub cli: String,
    pub model: Option<String>,
    pub chat: String,
}

/// What a commit is made of besides its message, which the signature covers.
pub struct Commit<'a> {
    pub tree: &'a str,
    pub parents: &'a [String],
}

/// The footer naming `agents` in `commit`, signed with the host's `key`.
pub fn footer(agents: &[Agent], commit: &Commit, key: Option<&SecretKey>) -> Vec<String> {
    let host = key.map(SecretKey::public);
    let mut lines: Vec<String> = agents
        .iter()
        .map(|agent| agent_line(agent, host.as_ref()))
        .collect();
    if let (Some(key), Some(host), false) = (key, host, agents.is_empty()) {
        let signature = key.sign(signed(commit, &host, agents).as_bytes());
        lines.push(format!(
            "{SIGNATURE}{}",
            BASE64.encode(signature.to_bytes())
        ));
    }
    lines
}

fn agent_line(agent: &Agent, host: Option<&PublicKey>) -> String {
    let chat = format!("chat {}", agent.chat);
    let host = host.map(|host| format!("host {}", short(host)));
    let parts: Vec<&str> = [Some(agent.cli.as_str()), agent.model.as_deref()]
        .into_iter()
        .chain([Some(chat.as_str()), host.as_deref()])
        .flatten()
        .collect();
    format!("{AGENT}{} ({})", agent.name, parts.join(", "))
}

fn short(host: &PublicKey) -> String {
    host.to_string()[..HOST_CHARS].to_owned()
}

fn signed(commit: &Commit, host: &PublicKey, agents: &[Agent]) -> String {
    let mut text = format!("sikemux agent footer 1\ntree {}\n", commit.tree);
    for parent in commit.parents {
        text.push_str(&format!("parent {parent}\n"));
    }
    text.push_str(&format!("host {host}\n"));
    for agent in agents {
        text.push_str(&format!("chat {}\n", agent.chat));
    }
    text
}

/// The agents a commit message's footer names, whether or not it checks out.
pub fn agents(message: &str) -> Vec<Agent> {
    read(message)
        .0
        .into_iter()
        .map(|(agent, _)| agent)
        .collect()
}

/// The agents `message`'s footer names, and the host of `hosts` that signed
/// it, when its signature checks out for `commit`.
pub fn verify(
    message: &str,
    commit: &Commit,
    hosts: &[PublicKey],
) -> Option<(PublicKey, Vec<Agent>)> {
    let (named, signature) = read(message);
    let signature = Signature::from_bytes(&BASE64.decode(signature?).ok()?.try_into().ok()?);
    let short_host = named.first()?.1.clone()?;
    if named
        .iter()
        .any(|(_, host)| host.as_ref() != Some(&short_host))
    {
        return None;
    }
    let agents: Vec<Agent> = named.into_iter().map(|(agent, _)| agent).collect();
    let host = hosts.iter().find(|host| {
        short(host) == short_host
            && host
                .verify(signed(commit, host, &agents).as_bytes(), &signature)
                .is_ok()
    })?;
    Some((*host, agents))
}

/// Each agent line of `message`'s footer with the host it names, and its
/// signature.
fn read(message: &str) -> (Vec<(Agent, Option<String>)>, Option<&str>) {
    let lines = last_paragraph(message.trim_end()).lines();
    let mut agents = Vec::new();
    let mut signature = None;
    for line in lines {
        if let Some(value) = line.strip_prefix(SIGNATURE) {
            signature = Some(value.trim());
        } else if let Some(agent) = line.strip_prefix(AGENT).and_then(parse_agent) {
            agents.push(agent);
        }
    }
    (agents, signature)
}

fn parse_agent(value: &str) -> Option<(Agent, Option<String>)> {
    let (name, rest) = value.split_once(" (")?;
    let mut parts: Vec<&str> = rest.strip_suffix(')')?.split(", ").collect();
    let host = match parts.last()?.strip_prefix("host ") {
        Some(host) => {
            parts.pop();
            Some(host.to_owned())
        }
        None => None,
    };
    let chat = parts.pop()?.strip_prefix("chat ")?.to_owned();
    let (cli, model) = match parts.as_slice() {
        [cli] => (*cli, None),
        [cli, model] => (*cli, Some((*model).to_owned())),
        _ => return None,
    };
    let name = name.trim();
    (!name.is_empty() && !chat.is_empty()).then(|| {
        let agent = Agent {
            name: name.to_owned(),
            cli: cli.to_owned(),
            model,
            chat,
        };
        (agent, host)
    })
}

/// `message` with `footer` at its end, in its own trailer block if it has
/// one, in place of any footer it had.
pub fn append(message: &str, footer: &[String]) -> String {
    let message = without_footer(message.trim_end());
    if footer.is_empty() {
        return message;
    }
    let joined = if message.contains("\n\n") && last_paragraph(&message).lines().all(is_trailer) {
        "\n"
    } else {
        "\n\n"
    };
    format!("{message}{joined}{}\n", footer.join("\n"))
}

/// The commit message file git is about to commit, with `footer` in place of
/// any it had, ahead of the comments and the cut line git takes out. None when
/// the message says nothing, which git refuses to commit.
pub fn into_message_file(text: &str, footer: &[String]) -> Option<String> {
    let (content, comments, cut) = message_file(text)?;
    if without_footer(content.trim_end()).trim().is_empty() {
        return None;
    }
    let comments = comments.trim_start_matches('\n');
    let gap = if comments.is_empty() { "" } else { "\n" };
    Some(format!("{}{gap}{comments}{cut}", append(content, footer)))
}

/// Whether the commit message file already ends in a signed footer.
pub fn is_signed(text: &str) -> bool {
    message_file(text).is_some_and(|(content, _, _)| read(content).1.is_some())
}

/// A commit message file's message, the comments after it, and the cut line
/// with what follows it.
fn message_file(text: &str) -> Option<(&str, &str, &str)> {
    let cut_at = line_starts(text)
        .find(|at| first_line(&text[*at..]).get(1..) == Some(SCISSORS))
        .unwrap_or(text.len());
    let (body, cut) = text.split_at(cut_at);
    let said = |line: &str| !line.trim().is_empty() && !line.starts_with('#');
    let end = line_starts(body)
        .filter(|at| said(first_line(&body[*at..])))
        .last()
        .map(|at| at + first_line(&body[at..]).len())?;
    let (content, comments) = body.split_at(end);
    Some((content, comments, cut))
}

fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or_default()
}

fn line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0)
        .chain(text.match_indices('\n').map(|(at, _)| at + 1))
        .filter(move |at| *at < text.len())
}

/// `message` without the footer lines of its trailer block.
fn without_footer(message: &str) -> String {
    let Some((before, last)) = message.rsplit_once("\n\n") else {
        return message.to_owned();
    };
    if !last.lines().all(is_trailer) {
        return message.to_owned();
    }
    let kept: Vec<&str> = last
        .lines()
        .filter(|line| !line.starts_with(AGENT) && !line.starts_with(SIGNATURE))
        .collect();
    match kept.as_slice() {
        [] => before.trim_end().to_owned(),
        kept => format!("{before}\n\n{}", kept.join("\n")),
    }
}

fn last_paragraph(message: &str) -> &str {
    message.rsplit("\n\n").next().unwrap_or_default()
}

fn is_trailer(line: &str) -> bool {
    line.split_once(": ").is_some_and(|(key, _)| {
        !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}
