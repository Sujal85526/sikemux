use std::sync::OnceLock;
use std::time::Duration;

use futures::StreamExt;
use reqwest::{Client, Method, Response};
use serde_json::Value;

use crate::error::{JiraError, JiraResult};

const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// Where a request goes and who it is from: a Jira Cloud site, and an email with its API token.
pub struct Credentials {
    pub url: String,
    pub email: String,
    pub token: String,
}

fn http() -> JiraResult<&'static Client> {
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .pool_idle_timeout(Duration::from_secs(25))
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("sikemux-jira/0.1")
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| JiraError::Transport("could not start the HTTP client".into()))
}

async fn read_limited(response: Response) -> JiraResult<Vec<u8>> {
    let too_big = || JiraError::Response("more than 16 MiB came back; narrow the query".into());
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(too_big());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(too_big());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Jira's error body: `errorMessages` for the request and `errors` per field.
pub fn error_message(body: &Value) -> Option<String> {
    let mut parts: Vec<String> = body
        .get("errorMessages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if let Some(fields) = body.get("errors").and_then(Value::as_object) {
        parts.extend(fields.iter().filter_map(|(field, message)| {
            message
                .as_str()
                .map(|message| format!("{field}: {message}"))
        }));
    }
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// One request to `path` on the site, e.g. `/rest/api/3/myself`. An empty answer, as a
/// transition or an assignment gives, comes back as `null`.
pub async fn send(
    credentials: &Credentials,
    method: Method,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
) -> JiraResult<Value> {
    let mut request = http()?
        .request(method, format!("{}{path}", credentials.url))
        .basic_auth(&credentials.email, Some(&credentials.token))
        .header("Accept", "application/json")
        .query(query);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await?;
    let status = response.status();
    let bytes = read_limited(response).await?;
    let parsed: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    if status.is_success() {
        return Ok(parsed);
    }
    let message = error_message(&parsed)
        .unwrap_or_else(|| String::from_utf8_lossy(&bytes).chars().take(400).collect());
    if matches!(status.as_u16(), 401) {
        return Err(JiraError::Auth(if message.is_empty() {
            "the email or API token was not accepted".into()
        } else {
            message
        }));
    }
    Err(JiraError::Http {
        status: status.as_u16(),
        message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jiras_errors_read_as_one_message() {
        let body = json!({ "errorMessages": ["Issue does not exist"], "errors": { "summary": "required" } });
        assert_eq!(
            error_message(&body).as_deref(),
            Some("Issue does not exist; summary: required")
        );
        assert_eq!(
            error_message(&json!({ "errorMessages": [], "errors": {} })),
            None
        );
    }
}
