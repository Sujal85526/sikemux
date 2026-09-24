// SigNoz: logs, service health and traces for the projects Sikemux has open.
//
//   config    — where SigNoz is, and the key in the Keychain the shell CLI shares
//   client    — the HTTP client, size limits, and SigNoz's error shapes
//   query     — v5 query_range builders, filter quoting, and time windows
//   logs      — search, and a tail that polls for new lines
//   services  — calls, errors and p99 per service, from entry spans
//   traces    — every span of one trace, ordered for a waterfall

mod client;
mod config;
mod error;
mod logs;
mod query;
mod services;
mod traces;

use std::path::Path;
use std::sync::Arc;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sikemux_plugin_api::{
    params, reply, Manifest, Plugin, PluginContext, PluginError, PluginFuture, StreamSink,
};

use crate::config::SignozConfig;
use crate::error::{SignozError, SignozResult};

pub fn plugin() -> Result<Arc<dyn Plugin>, PluginError> {
    Ok(Arc::new(Signoz {
        manifest: Manifest::from_json(include_str!("../manifest.json"))?,
    }))
}

struct Signoz {
    manifest: Manifest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    configured: bool,
    url: String,
    account: String,
    key_from_environment: bool,
    version: Option<String>,
    ok: bool,
    auth_failed: bool,
    message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Login {
    url: String,
    account: String,
    /// Left out to use a key the Keychain already holds for this account.
    api_key: Option<String>,
}

async fn status(data_dir: &Path) -> Status {
    let config = config::load(data_dir);
    let key_from_environment = config::has_env_key();
    let base = |ok, auth_failed, version, message| Status {
        configured: !config.url.is_empty() && (key_from_environment || !config.account.is_empty()),
        url: config.url.clone(),
        account: config.account.clone(),
        key_from_environment,
        version,
        ok,
        auth_failed,
        message,
    };
    let credentials = match client::credentials(data_dir).await {
        Ok(credentials) => credentials,
        Err(SignozError::Unconfigured) => return base(false, false, None, None),
        Err(error) => return base(false, false, None, Some(error.to_string())),
    };
    let version = client::request(&credentials, Method::GET, "/api/v1/version", None)
        .await
        .ok()
        .and_then(|body| {
            body.get("version")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let probe = query::builder(
        "raw",
        query::window(Some(1)),
        json!({ "signal": "logs", "limit": 1 }),
    );
    match client::query_range(&credentials, &probe).await {
        Ok(_) => base(true, false, version, None),
        Err(error) => {
            let auth_failed = matches!(
                error,
                SignozError::Http {
                    status: 401 | 403,
                    ..
                }
            );
            base(false, auth_failed, version, Some(error.to_string()))
        }
    }
}

async fn login(data_dir: &Path, request: Login) -> SignozResult<Status> {
    let url = config::validate_url(&request.url)?;
    let account = config::validate_account(&request.account)?;
    let config = SignozConfig {
        url,
        account: account.clone(),
    };
    let data_dir_owned = data_dir.to_path_buf();
    tokio::task::spawn_blocking(move || -> SignozResult<()> {
        if let Some(key) = request
            .api_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
        {
            config::keychain_write(&account, key)?;
        }
        config::save(&data_dir_owned, &config)
    })
    .await
    .map_err(|error| SignozError::Keychain(error.to_string()))??;
    Ok(status(data_dir).await)
}

async fn answer<T: Serialize>(
    result: impl std::future::Future<Output = SignozResult<T>>,
) -> Result<Value, PluginError> {
    reply(result.await?)
}

impl Plugin for Signoz {
    fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn call<'a>(
        &'a self,
        ctx: &'a PluginContext,
        method: &'a str,
        input: Value,
    ) -> PluginFuture<'a, Value> {
        Box::pin(async move {
            let data_dir = ctx.data_dir();
            match method {
                "status" => reply(status(data_dir).await),
                "login" => answer(login(data_dir, params(input)?)).await,
                "searchLogs" => answer(logs::search(data_dir, params(input)?)).await,
                "services" => answer(services::health(data_dir, params(input)?)).await,
                "trace" => answer(traces::trace(data_dir, params(input)?)).await,
                _ => Err(PluginError::unknown_method(method)),
            }
        })
    }

    fn stream<'a>(
        &'a self,
        ctx: &'a PluginContext,
        method: &'a str,
        input: Value,
        sink: StreamSink,
    ) -> PluginFuture<'a, ()> {
        Box::pin(async move {
            match method {
                "tailLogs" => logs::tail(ctx.data_dir(), params(input)?, sink).await,
                _ => Err(PluginError::unknown_method(method)),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn its_manifest_parses() {
        assert_eq!(
            plugin().expect("manifest parses").manifest().id,
            "sikemux.signoz"
        );
    }
}

/// Runs against a real SigNoz only when asked:
/// `SIGNOZ_LIVE_URL=… SIGNOZ_LIVE_ACCOUNT=… cargo test -p sikemux-plugin-signoz -- --ignored`
#[cfg(test)]
mod live {
    use super::*;

    fn context() -> Option<(PluginContext, std::path::PathBuf)> {
        let url = std::env::var("SIGNOZ_LIVE_URL").ok()?;
        let account = std::env::var("SIGNOZ_LIVE_ACCOUNT").ok()?;
        let dir = std::env::temp_dir().join(format!("sikemux-signoz-live-{}", std::process::id()));
        config::save(&dir, &SignozConfig { url, account }).expect("config saves");
        Some((PluginContext::new(dir.clone()), dir))
    }

    #[tokio::test]
    #[ignore]
    async fn answers_every_method() {
        let Some((ctx, dir)) = context() else { return };
        let plugin = plugin().expect("plugin loads");
        let status = plugin
            .call(&ctx, "status", Value::Null)
            .await
            .expect("status");
        assert_eq!(status["ok"], true, "{status}");

        let services = plugin
            .call(&ctx, "services", json!({ "minutes": 15 }))
            .await
            .expect("services");
        let busiest = services[0]["service"]
            .as_str()
            .expect("a service")
            .to_string();

        let page = plugin
            .call(
                &ctx,
                "searchLogs",
                json!({ "severities": ["ERROR"], "minutes": 60, "limit": 5 }),
            )
            .await
            .expect("logs");
        let lines = page["lines"].as_array().expect("lines");
        assert!(lines.len() <= 5);

        let spans = plugin
            .call(
                &ctx,
                "searchLogs",
                json!({ "service": busiest, "minutes": 15, "limit": 1 }),
            )
            .await
            .expect("service logs");
        if let Some(trace_id) = spans["lines"][0]["traceId"].as_str() {
            let trace = plugin
                .call(&ctx, "trace", json!({ "traceId": trace_id, "minutes": 60 }))
                .await
                .expect("trace");
            assert_eq!(trace["traceId"], trace_id);
        }

        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let sink = StreamSink::new(move |item| sender.send(item).is_ok());
        let tail = plugin.stream(&ctx, "tailLogs", json!({ "minutes": 5, "limit": 3 }), sink);
        let first = tokio::select! {
            item = receiver.recv() => item,
            _ = tail => None,
        };
        let first = first.expect("the tail sends its backlog");
        assert!(first["error"].is_null(), "{first}");

        std::fs::remove_dir_all(dir).ok();
        eprintln!(
            "live: {} services, busiest {busiest}, {} error lines",
            services.as_array().map_or(0, Vec::len),
            lines.len()
        );
    }
}
