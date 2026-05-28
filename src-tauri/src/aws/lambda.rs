use serde::{Deserialize, Serialize};

use crate::error::AppResult;

use super::common::aws_json_async;

#[derive(Serialize, Clone)]
pub struct LambdaFn {
    name: String,
    runtime: Option<String>,
    last_modified: Option<String>,
    memory_size: Option<i64>,
    timeout: Option<i64>,
    handler: Option<String>,
}

#[tauri::command]
pub async fn aws_lambda_functions(profile: String) -> AppResult<Vec<LambdaFn>> {
    #[derive(Deserialize)]
    struct Resp {
        #[serde(rename = "Functions")]
        functions: Vec<Fn0>,
    }
    #[derive(Deserialize)]
    struct Fn0 {
        #[serde(rename = "FunctionName")]
        name: String,
        #[serde(rename = "Runtime")]
        runtime: Option<String>,
        #[serde(rename = "LastModified")]
        last_modified: Option<String>,
        #[serde(rename = "MemorySize")]
        memory_size: Option<i64>,
        #[serde(rename = "Timeout")]
        timeout: Option<i64>,
        #[serde(rename = "Handler")]
        handler: Option<String>,
    }
    let resp: Resp =
        aws_json_async(&profile, &["lambda", "list-functions", "--output", "json"]).await?;
    let mut out: Vec<LambdaFn> = resp
        .functions
        .into_iter()
        .map(|f| LambdaFn {
            name: f.name,
            runtime: f.runtime,
            last_modified: f.last_modified,
            memory_size: f.memory_size,
            timeout: f.timeout,
            handler: f.handler,
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}
