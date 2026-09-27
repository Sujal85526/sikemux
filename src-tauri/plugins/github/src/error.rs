use std::fmt;

use sikemux_plugin_api::PluginError;

#[derive(Debug)]
pub enum ActionsError {
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

impl fmt::Display for ActionsError {
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

impl From<reqwest::Error> for ActionsError {
    fn from(error: reqwest::Error) -> Self {
        Self::Transport(error.to_string())
    }
}

impl From<serde_json::Error> for ActionsError {
    fn from(error: serde_json::Error) -> Self {
        Self::Response(error.to_string())
    }
}

impl From<ActionsError> for PluginError {
    fn from(error: ActionsError) -> Self {
        let (category, status) = match &error {
            ActionsError::Unconfigured => ("unconfigured", None),
            ActionsError::Auth(_) => ("auth", None),
            ActionsError::Forbidden(_) => ("forbidden", Some(403)),
            ActionsError::RateLimited { .. } => ("rate-limited", Some(429)),
            ActionsError::Http { status, .. } => ("http", Some(*status)),
            ActionsError::BadArg(_) => ("bad-params", None),
            ActionsError::NotFound(_) => ("not-found", Some(404)),
            ActionsError::Keychain(_) => ("keychain", None),
            ActionsError::Transport(_) => ("github", None),
            ActionsError::Response(_) => ("response", None),
        };
        let plugin_error = PluginError::new(category, error.to_string());
        match status {
            Some(status) => plugin_error.with_status(status),
            None => plugin_error,
        }
    }
}

pub type ActionsResult<T> = Result<T, ActionsError>;
