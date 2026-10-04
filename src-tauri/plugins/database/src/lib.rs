// Databases: saved connections, their schemas, and SQL run against them.
//
//   profiles — the databases saved here, and their passwords in the Keychain

mod error;
mod profiles;

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use sikemux_plugin_api::{
    params, reply, Manifest, Plugin, PluginContext, PluginError, PluginFuture,
};

use crate::error::DatabaseResult;

pub fn plugin() -> Result<Arc<dyn Plugin>, PluginError> {
    Ok(Arc::new(Database {
        manifest: Manifest::from_json(include_str!("../manifest.json"))?,
    }))
}

struct Database {
    manifest: Manifest,
}

async fn answer<T: Serialize>(
    result: impl std::future::Future<Output = DatabaseResult<T>>,
) -> Result<Value, PluginError> {
    reply(result.await?)
}

impl Plugin for Database {
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
            let data_dir = ctx.data_dir().to_path_buf();
            match method {
                "profiles" => reply(profiles::load(&data_dir).profiles),
                "save" => {
                    let request: profiles::SaveRequest = params(input)?;
                    answer(profiles::blocking(move || {
                        profiles::save(&data_dir, request)
                    }))
                    .await
                }
                "remove" => {
                    let profiles::IdRequest { id } = params(input)?;
                    answer(profiles::blocking(move || profiles::remove(&data_dir, &id))).await
                }
                _ => Err(PluginError::unknown_method(method)),
            }
        })
    }

    fn offers_agent_tools<'a>(
        &'a self,
        ctx: &'a PluginContext,
        _remotes: &'a [String],
    ) -> PluginFuture<'a, bool> {
        Box::pin(async move { Ok(!profiles::load(ctx.data_dir()).profiles.is_empty()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PluginContext {
        let dir = std::env::temp_dir().join(format!(
            "sikemux-database-plugin-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        PluginContext::new(dir)
    }

    #[tokio::test]
    async fn a_profile_is_saved_listed_and_removed_through_its_methods() {
        let ctx = scratch("methods");
        let database = plugin().unwrap();
        assert_eq!(
            database.offers_agent_tools(&ctx, &[]).await.ok(),
            Some(false)
        );
        let saved = database
            .call(
                &ctx,
                "save",
                json!({ "profile": { "name": "Local", "engine": "sqlite", "path": "/tmp/x.db" } }),
            )
            .await
            .unwrap();
        let listed = database.call(&ctx, "profiles", Value::Null).await.unwrap();
        assert_eq!(listed, json!([saved.clone()]));
        assert_eq!(
            database.offers_agent_tools(&ctx, &[]).await.ok(),
            Some(true)
        );
        database
            .call(&ctx, "remove", json!({ "id": saved["id"] }))
            .await
            .unwrap();
        let listed = database.call(&ctx, "profiles", Value::Null).await.unwrap();
        assert_eq!(listed, json!([]));
        assert!(database.call(&ctx, "nope", Value::Null).await.is_err());
    }
}
