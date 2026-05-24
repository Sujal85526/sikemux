// Application-wide error taxonomy. Every Tauri command's Err arm flows
// through a variant of `AppError`; the IntoResponse `Display` impl renders
// what the frontend gets. Callers in the frontend that need to branch on a
// specific failure (auth expired vs cli missing vs network error) read the
// shape via the serde-tagged `category()` rather than substring-matching the
// rendered message.

use std::io;

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("io: {0}")]
    Io(#[from] io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("git: {0}")]
    Git(String),

    #[error("aws: {0}")]
    Aws(String),

    #[error("aws cli not on PATH: {0}")]
    AwsCliMissing(String),

    #[error("aws sso/session token expired")]
    AwsTokenExpired,

    #[error("aws: no credentials configured")]
    AwsNoCredentials,

    #[error("lsp: {0}")]
    Lsp(String),

    #[error("invalid argument: {0}")]
    BadArg(&'static str),

    #[error("{0}")]
    Other(String),
}

impl From<git2::Error> for AppError {
    fn from(e: git2::Error) -> Self {
        AppError::Git(e.message().to_string())
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Other(s.to_string())
    }
}

// Tauri's #[command] requires the Err type to be Serialize so it lands as a
// JSON payload on the frontend side. We emit `{ category, message }` so the
// frontend can branch on category without parsing message text.
#[derive(Serialize)]
struct Wire<'a> {
    category: &'a str,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        Wire {
            category: self.category(),
            message: self.to_string(),
        }
        .serialize(ser)
    }
}

impl AppError {
    pub fn category(&self) -> &'static str {
        match self {
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
            AppError::Git(_) => "git",
            AppError::Aws(_) => "aws",
            AppError::AwsCliMissing(_) => "aws-cli-missing",
            AppError::AwsTokenExpired => "aws-token-expired",
            AppError::AwsNoCredentials => "aws-no-credentials",
            AppError::Lsp(_) => "lsp",
            AppError::BadArg(_) => "bad-arg",
            AppError::Other(_) => "other",
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
