// Whether each agent can be used right now: found, working, and signed in.
// Every agent answers sign-in its own way, and some cannot answer at all, so
// `Unknown` is an honest answer rather than a failure.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AgentStatus {
    /// No binary was found.
    Missing,
    /// A binary was found but does not run.
    Broken { reason: String },
    /// Installed, with no usable credentials.
    SignedOut,
    /// Installed and signed in. `account` is the kind of sign-in when the CLI says, never who.
    #[serde(rename_all = "camelCase")]
    Ready { account: Option<String> },
    /// The agent has no reliable way to say whether it is signed in.
    Unknown,
}

/// Provider keys OpenCode reads from the environment; any one of them is a way in.
const OPENCODE_KEY_VARIABLES: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
];

/// `pi auth check` answers with its exit code: 0 ready, 1 not ready, 2 credentials that no longer work.
/// Anything else means this pi does not know the command.
pub(super) fn pi_status(exit_code: Option<i32>) -> AgentStatus {
    match exit_code {
        Some(0) => AgentStatus::Ready { account: None },
        Some(1 | 2) => AgentStatus::SignedOut,
        _ => AgentStatus::Unknown,
    }
}

fn without_escapes(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        plain.push(c);
    }
    plain
}

/// `opencode auth list` ends with a count such as "1 credentials". A provider key in the
/// environment counts as well, since OpenCode reads those without a stored credential.
pub(super) fn opencode_status<'a>(
    listing: &str,
    environment: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> AgentStatus {
    let plain = without_escapes(listing);
    let stored = plain
        .lines()
        .filter_map(|line| {
            let words: Vec<&str> = line
                .trim_matches(|c: char| !c.is_alphanumeric())
                .split_whitespace()
                .collect();
            match words.as_slice() {
                [count, noun, ..] if noun.starts_with("credential") => count.parse::<u32>().ok(),
                _ => None,
            }
        })
        .last();
    if stored.is_some_and(|count| count > 0) {
        return AgentStatus::Ready { account: None };
    }
    let has_key = environment
        .into_iter()
        .any(|(name, value)| OPENCODE_KEY_VARIABLES.contains(&name) && !value.trim().is_empty());
    if has_key {
        return AgentStatus::Ready {
            account: Some("apiKey".into()),
        };
    }
    match stored {
        Some(_) => AgentStatus::SignedOut,
        None => AgentStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_read_as_a_state_and_its_details() {
        let ready = serde_json::to_value(AgentStatus::Ready {
            account: Some("subscription".into()),
        })
        .unwrap();
        assert_eq!(
            ready,
            serde_json::json!({ "state": "ready", "account": "subscription" })
        );
        assert_eq!(
            serde_json::to_value(AgentStatus::SignedOut).unwrap(),
            serde_json::json!({ "state": "signedOut" })
        );
        assert_eq!(
            serde_json::to_value(AgentStatus::Broken {
                reason: "exit 127".into()
            })
            .unwrap(),
            serde_json::json!({ "state": "broken", "reason": "exit 127" })
        );
    }

    #[test]
    fn pi_answers_with_its_exit_code() {
        assert_eq!(pi_status(Some(0)), AgentStatus::Ready { account: None });
        assert_eq!(pi_status(Some(1)), AgentStatus::SignedOut);
        assert_eq!(pi_status(Some(2)), AgentStatus::SignedOut);
        assert_eq!(pi_status(Some(64)), AgentStatus::Unknown);
        assert_eq!(pi_status(None), AgentStatus::Unknown);
    }

    #[test]
    fn opencode_counts_its_credentials_and_provider_keys() {
        let one = "\u{1b}[0m\n┌  Credentials \u{1b}[90m~/.local/share/opencode/auth.json\n│\n●  Anthropic \u{1b}[90mapi\n│\n└  1 credentials\n";
        assert_eq!(
            opencode_status(one, []),
            AgentStatus::Ready { account: None }
        );
        let none = "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n";
        assert_eq!(opencode_status(none, []), AgentStatus::SignedOut);
        assert_eq!(
            opencode_status(none, [("OPENAI_API_KEY", "sk-test")]),
            AgentStatus::Ready {
                account: Some("apiKey".into())
            }
        );
        assert_eq!(
            opencode_status(none, [("OPENAI_API_KEY", " "), ("PATH", "/bin")]),
            AgentStatus::SignedOut
        );
        assert_eq!(opencode_status("something else", []), AgentStatus::Unknown);
    }
}
