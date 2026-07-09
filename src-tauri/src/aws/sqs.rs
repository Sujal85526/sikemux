use serde::{Deserialize, Serialize};

use crate::error::AppResult;

use super::common::aws_json_async;

#[derive(Serialize, Clone)]
pub struct SqsQueue {
    name: String,
    url: String,
    messages: Option<String>,
    in_flight: Option<String>,
    delayed: Option<String>,
}

#[tauri::command]
pub async fn aws_sqs_queues(profile: String) -> AppResult<Vec<SqsQueue>> {
    #[derive(Deserialize)]
    struct Resp {
        #[serde(default, rename = "QueueUrls")]
        urls: Vec<String>,
    }
    let resp: Resp = aws_json_async(&profile, &["sqs", "list-queues", "--output", "json"])
        .await
        .unwrap_or(Resp { urls: vec![] });

    let mut out = Vec::new();
    for url in resp.urls {
        let name = url.rsplit('/').next().unwrap_or(&url).to_string();
        // Skip attribute fetch — too many round-trips for a list view.
        // Detail panel will pull get-queue-attributes per queue lazily.
        out.push(SqsQueue {
            name,
            url,
            messages: None,
            in_flight: None,
            delayed: None,
        });
    }
    out.sort_by_key(|queue| queue.name.to_lowercase());
    Ok(out)
}
