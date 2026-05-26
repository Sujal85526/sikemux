use serde::{Deserialize, Serialize};

use crate::error::AppResult;

use super::common::aws_json_async;

#[derive(Serialize, Clone)]
pub struct S3Bucket {
    name: String,
    created_at: Option<String>,
}

#[tauri::command]
pub async fn aws_s3_buckets(profile: String) -> AppResult<Vec<S3Bucket>> {
    #[derive(Deserialize)]
    struct Resp {
        #[serde(rename = "Buckets")]
        buckets: Vec<B>,
    }
    #[derive(Deserialize)]
    struct B {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "CreationDate")]
        created: Option<String>,
    }
    let resp: Resp = aws_json_async(
        &profile,
        &["s3api", "list-buckets", "--output", "json"],
    )
    .await?;
    let mut out: Vec<S3Bucket> = resp
        .buckets
        .into_iter()
        .map(|b| S3Bucket {
            name: b.name,
            created_at: b.created,
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}
