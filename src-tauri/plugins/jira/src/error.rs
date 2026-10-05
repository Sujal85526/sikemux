use std::fmt;

use sikemux_plugin_api::PluginError;

#[derive(Debug)]
pub enum JiraError {
    Unconfigured,
    Auth(String),
    Http { status: u16, message: String },
    BadArg(String),
    NotFound(String),
    Keychain(String),
    Transport(String),
    Response(String),
}

impl fmt::Display for JiraError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unconfigured => formatter.write_str("jira: no site is signed in"),
            Self::Auth(message) => write!(formatter, "jira: sign-in failed: {message}"),
            Self::Http { status, message } => write!(formatter, "jira: http {status}: {message}"),
            Self::BadArg(message) => write!(formatter, "invalid argument: {message}"),
            Self::NotFound(message) => formatter.write_str(message),
            Self::Keychain(message) => write!(formatter, "keychain: {message}"),
            Self::Transport(message) => write!(formatter, "jira: {message}"),
            Self::Response(message) => write!(formatter, "jira: unexpected response: {message}"),
        }
    }
}

impl From<reqwest::Error> for JiraError {
    fn from(error: reqwest::Error) -> Self {
        Self::Transport(error.to_string())
    }
}

impl From<serde_json::Error> for JiraError {
    fn from(error: serde_json::Error) -> Self {
        Self::Response(error.to_string())
    }
}

impl From<JiraError> for PluginError {
    fn from(error: JiraError) -> Self {
        let (category, status) = match &error {
            JiraError::Unconfigured => ("unconfigured", None),
            JiraError::Auth(_) => ("auth", None),
            JiraError::Http { status, .. } => ("http", Some(*status)),
            JiraError::BadArg(_) => ("bad-params", None),
            JiraError::NotFound(_) => ("not-found", None),
            JiraError::Keychain(_) => ("keychain", None),
            JiraError::Transport(_) => ("jira", None),
            JiraError::Response(_) => ("response", None),
        };
        let plugin_error = PluginError::new(category, error.to_string());
        match status {
            Some(status) => plugin_error.with_status(status),
            None => plugin_error,
        }
    }
}

pub type JiraResult<T> = Result<T, JiraError>;
