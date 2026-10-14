//! Git commands an agent may not run in a checkout other agents share, since
//! each would take in or throw away their uncommitted work along with its own.

/// Why `command`, a shell command line, may not run, if it may not.
pub(crate) fn refusal(command: &str) -> Option<String> {
    segments(command).iter().find_map(|words| {
        let words = command_words(words)?;
        if let [shell, flag, script, ..] = words {
            if is_shell(shell) && flag.starts_with('-') && flag.ends_with('c') {
                return refusal(script);
            }
        }
        let (first, args) = words.split_first()?;
        if base_name(first) != "git" {
            return None;
        }
        let args = git_args(args);
        let why = sweeping(args)?;
        let shown = format!("git {}", args.join(" "));
        Some(format!(
            "Sikemux blocked `{shown}`: it {why}, and other agents share this checkout. Commit your own lines with the git_commit tool, and stage or restore files by path."
        ))
    })
}

fn sweeping(args: &[String]) -> Option<&'static str> {
    let (sub, rest) = args.split_first()?;
    let everything = |paths: &[String]| {
        paths
            .iter()
            .any(|path| matches!(path.as_str(), "." | "./" | ":/" | ":" | "*" | ":(top)"))
    };
    let short = |letter: char, valued: &str| {
        flags_before_paths(rest).any(|flag| {
            flag.strip_prefix('-')
                .filter(|letters| !letters.starts_with('-'))
                .is_some_and(|letters| {
                    letters
                        .chars()
                        .take_while(|c| !valued.contains(*c))
                        .any(|c| c == letter)
                })
        })
    };
    let long = |name: &str| flags_before_paths(rest).any(|flag| flag == name);
    match sub.as_str() {
        "add" if short('A', "") || short('u', "") || long("--all") || long("--update") => {
            Some("stages every change in the checkout")
        }
        "add" if everything(rest) => Some("stages every change in the checkout"),
        "commit" if short('a', "mFCctS") || long("--all") => {
            Some("commits every change in the checkout")
        }
        "stash" if !matches!(rest.first().map(String::as_str), Some("list" | "show")) => {
            Some("takes every uncommitted change out of the checkout")
        }
        "reset" if long("--hard") || long("--merge") || long("--keep") => {
            Some("throws away uncommitted changes")
        }
        "checkout" | "restore" if everything(rest) => Some("throws away uncommitted changes"),
        "clean" if short('f', "eE") || long("--force") => Some("deletes files nobody committed"),
        _ => None,
    }
}

/// The flags before a `--`.
fn flags_before_paths(args: &[String]) -> impl Iterator<Item = &str> {
    args.iter()
        .map(String::as_str)
        .take_while(|arg| *arg != "--")
        .filter(|arg| arg.starts_with('-'))
}

/// `git`'s arguments from its subcommand on, past options such as `-C dir`.
fn git_args(args: &[String]) -> &[String] {
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        match arg.as_str() {
            "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace" => at += 2,
            arg if arg.starts_with('-') => at += 1,
            _ => break,
        }
    }
    args.get(at..).unwrap_or_default()
}

/// A command's words without what runs it, such as `env X=1` or `sudo`.
fn command_words(words: &[String]) -> Option<&[String]> {
    let runner = |word: &str| {
        matches!(
            word,
            "env" | "command" | "exec" | "sudo" | "time" | "nice" | "nohup" | "builtin"
        ) || word.split_once('=').is_some_and(|(name, _)| {
            !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    };
    let at = words.iter().position(|word| !runner(word))?;
    Some(&words[at..])
}

fn base_name(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

fn is_shell(word: &str) -> bool {
    matches!(base_name(word), "sh" | "bash" | "zsh" | "dash")
}

/// The words of each simple command in `line`, split at `;`, `&`, `|`,
/// brackets, backticks and line breaks outside quotes.
fn segments(line: &str) -> Vec<Vec<String>> {
    let mut segments = vec![Vec::new()];
    let mut word: Option<String> = None;
    let mut chars = line.chars();
    let end_word = |word: &mut Option<String>, segments: &mut Vec<Vec<String>>| {
        if let Some(done) = word.take() {
            if let Some(last) = segments.last_mut() {
                last.push(done);
            }
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                let quoted: String = chars.by_ref().take_while(|c| *c != '\'').collect();
                word.get_or_insert_with(String::new).push_str(&quoted);
            }
            '"' => {
                let text = word.get_or_insert_with(String::new);
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' => text.extend(chars.next()),
                        c => text.push(c),
                    }
                }
            }
            '\\' => word.get_or_insert_with(String::new).extend(chars.next()),
            ';' | '&' | '|' | '(' | ')' | '`' | '\n' | '{' | '}' => {
                end_word(&mut word, &mut segments);
                segments.push(Vec::new());
            }
            c if c.is_whitespace() => end_word(&mut word, &mut segments),
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    end_word(&mut word, &mut segments);
    segments.retain(|words| !words.is_empty());
    segments
}
