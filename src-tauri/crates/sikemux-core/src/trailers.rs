//! The lines that end a commit message Sikemux makes, one per agent whose
//! changes it holds: `Agent: Otter (claude, opus, chat 0199…)`.

const KEY: &str = "Agent: ";

pub fn agent(name: &str, cli: &str, model: Option<&str>, chat: &str) -> String {
    match model {
        Some(model) => format!("{KEY}{name} ({cli}, {model}, chat {chat})"),
        None => format!("{KEY}{name} ({cli}, chat {chat})"),
    }
}

/// `message` with `trailers` at its end, in its own trailer block if it has one.
pub fn append(message: &str, trailers: &[String]) -> String {
    let message = message.trim_end();
    if trailers.is_empty() {
        return message.to_owned();
    }
    let joined = if message.contains("\n\n") && last_paragraph(message).lines().all(is_trailer) {
        "\n"
    } else {
        "\n\n"
    };
    format!("{message}{joined}{}\n", trailers.join("\n"))
}

/// The names of the agents a commit message's trailers list.
pub fn agents(message: &str) -> Vec<String> {
    last_paragraph(message.trim_end())
        .lines()
        .filter_map(|line| line.strip_prefix(KEY))
        .map(|value| value.split(" (").next().unwrap_or(value).trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect()
}

/// The ids of the agents a commit message's trailers list.
pub fn agent_ids(message: &str) -> Vec<String> {
    last_paragraph(message.trim_end())
        .lines()
        .filter(|line| line.starts_with(KEY))
        .filter_map(|line| line.rsplit_once(", chat ")?.1.strip_suffix(')'))
        .map(str::to_owned)
        .collect()
}

fn last_paragraph(message: &str) -> &str {
    message.rsplit("\n\n").next().unwrap_or_default()
}

fn is_trailer(line: &str) -> bool {
    line.split_once(": ").is_some_and(|(key, _)| {
        !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}
