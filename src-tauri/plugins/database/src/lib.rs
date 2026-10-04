// Databases: saved connections, their schemas, and SQL run against them.
//
//   profiles    — the databases saved here, and their passwords in the Keychain
//   engines     — one open connection, whichever engine the database runs on
//   connections — trying a connection, and keeping one open per saved database
//   values      — query results, the same for every engine

mod connections;
mod engines;
mod error;
mod profiles;
mod values;

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
        pool: connections::Pool::default(),
    }))
}

struct Database {
    manifest: Manifest,
    pool: connections::Pool,
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
                    let saved =
                        profiles::blocking(move || profiles::save(&data_dir, request)).await?;
                    self.pool.forget(&saved.id).await;
                    reply(saved)
                }
                "remove" => {
                    let profiles::IdRequest { id } = params(input)?;
                    self.pool.forget(&id).await;
                    answer(profiles::blocking(move || profiles::remove(&data_dir, &id))).await
                }
                "test" => answer(connections::test(data_dir, params(input)?)).await,
                "connect" => {
                    let profiles::IdRequest { id } = params(input)?;
                    answer(self.pool.connect(&data_dir, &id)).await
                }
                "disconnect" => {
                    let profiles::IdRequest { id } = params(input)?;
                    self.pool.forget(&id).await;
                    reply(())
                }
                "connected" => reply(self.pool.connected().await),
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

    #[tokio::test]
    async fn testing_a_connection_names_the_engine_and_its_version() {
        let ctx = scratch("test");
        let database = plugin().unwrap();
        let path = engines::sqlite::tests::fixture("plugin-test");
        let tested = database
            .call(
                &ctx,
                "test",
                json!({ "profile": { "name": "Local", "engine": "sqlite", "path": path } }),
            )
            .await
            .unwrap();
        assert!(tested["version"].as_str().unwrap().starts_with("SQLite"));
        let missing = database
            .call(
                &ctx,
                "test",
                json!({ "profile": { "name": "Gone", "engine": "sqlite", "path": "/nope/x.db" } }),
            )
            .await;
        assert_eq!(
            missing.err().map(|error| error.category),
            Some("connect".to_string())
        );
    }

    #[tokio::test]
    async fn editing_a_connected_profile_closes_its_connection() {
        let ctx = scratch("edit-closes");
        let database = plugin().unwrap();
        let path = engines::sqlite::tests::fixture("plugin-edit");
        let profile = json!({ "name": "Local", "engine": "sqlite", "path": path });
        let saved = database
            .call(&ctx, "save", json!({ "profile": profile }))
            .await
            .unwrap();
        let id = saved["id"].clone();
        database
            .call(&ctx, "connect", json!({ "id": id }))
            .await
            .unwrap();
        let connected = database.call(&ctx, "connected", Value::Null).await.unwrap();
        assert_eq!(connected[0]["id"], id);
        let mut edited = profile.clone();
        edited["id"] = id.clone();
        edited["name"] = json!("Renamed");
        database
            .call(&ctx, "save", json!({ "profile": edited }))
            .await
            .unwrap();
        let connected = database.call(&ctx, "connected", Value::Null).await.unwrap();
        assert_eq!(connected, json!([]));
    }
}
