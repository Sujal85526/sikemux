use std::fmt;

use sikemux_plugin_api::PluginError;

#[derive(Debug)]
pub enum GithubError {
    Unconfigured,
    Auth(String),
    Forbidden(String),
    RateLimited { resets_in_secs: u64 },
    Http { status: u16, message: String },
    BadArg(String),
    NotFound(String),
    Keychain(String),
    Transport(String),
    Response(String),
}

impl fmt::Display for GithubError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unconfigured => formatter.write_str("github: not signed in"),
            Self::Auth(message) => write!(formatter, "github: sign-in failed: {message}"),
            Self::Forbidden(message) => write!(formatter, "github: not allowed: {message}"),
            Self::RateLimited { resets_in_secs } => write!(
                formatter,
                "github: rate limit reached; it resets in {resets_in_secs}s"
            ),
            Self::Http { status, message } => write!(formatter, "github: http {status}: {message}"),
            Self::BadArg(message) => write!(formatter, "invalid argument: {message}"),
            Self::NotFound(message) => formatter.write_str(message),
            Self::Keychain(message) => write!(formatter, "keychain: {message}"),
            Self::Transport(message) => write!(formatter, "github: {message}"),
            Self::Response(message) => write!(formatter, "github: unexpected response: {message}"),
        }
    }
}

impl From<reqwest::Error> for GithubError {
    fn from(error: reqwest::Error) -> Self {
        Self::Transport(error.to_string())
    }
}

impl From<serde_json::Error> for GithubError {
    fn from(error: serde_json::Error) -> Self {
        Self::Response(error.to_string())
    }
}

impl From<GithubError> for PluginError {
    fn from(error: GithubError) -> Self {
        let (category, status) = match &error {
            GithubError::Unconfigured => ("unconfigured", None),
            GithubError::Auth(_) => ("auth", None),
            GithubError::Forbidden(_) => ("forbidden", Some(403)),
            GithubError::RateLimited { .. } => ("rate-limited", Some(429)),
            GithubError::Http { status, .. } => ("http", Some(*status)),
            GithubError::BadArg(_) => ("bad-params", None),
            GithubError::NotFound(_) => ("not-found", Some(404)),
            GithubError::Keychain(_) => ("keychain", None),
            GithubError::Transport(_) => ("github", None),
            GithubError::Response(_) => ("response", None),
        };
        let plugin_error = PluginError::new(category, error.to_string());
        match status {
            Some(status) => plugin_error.with_status(status),
            None => plugin_error,
        }
    }
}

pub type GithubResult<T> = Result<T, GithubError>;
