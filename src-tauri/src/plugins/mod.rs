mod builtin;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use sikemux_plugin_api::{Manifest, Plugin, PluginContext, PluginError, StreamSink};
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};

struct Loaded {
    plugin: Arc<dyn Plugin>,
    context: Arc<PluginContext>,
}

pub struct PluginHost {
    plugins: BTreeMap<String, Loaded>,
    streams: Arc<DashMap<u32, JoinHandle<()>>>,
    next_stream: AtomicU32,
}

impl PluginHost {
    pub fn with_builtins(data_root: &Path, sikemux: &Version) -> Self {
        Self::new(data_root, sikemux, builtin::plugins())
    }

    fn new(data_root: &Path, sikemux: &Version, plugins: Vec<Arc<dyn Plugin>>) -> Self {
        let mut loaded = BTreeMap::new();
        for plugin in plugins {
            let manifest = plugin.manifest();
            if !manifest.supports(sikemux) {
                eprintln!(
                    "plugin {} needs sikemux {} and this is {sikemux}; not loading it",
                    manifest.id, manifest.sikemux
                );
                continue;
            }
            if loaded.contains_key(&manifest.id) {
                eprintln!(
                    "plugin {} is registered twice; keeping the first",
                    manifest.id
                );
                continue;
            }
            let context = Arc::new(PluginContext::new(data_root.join(&manifest.id)));
            loaded.insert(manifest.id.clone(), Loaded { plugin, context });
        }
        Self {
            plugins: loaded,
            streams: Arc::default(),
            next_stream: AtomicU32::new(1),
        }
    }

    fn get(&self, id: &str) -> AppResult<&Loaded> {
        self.plugins.get(id).ok_or_else(|| AppError::Plugin {
            plugin: id.to_owned(),
            error: PluginError::new("not-installed", format!("no plugin named `{id}`")),
        })
    }

    pub fn manifests(&self) -> Vec<Manifest> {
        self.plugins
            .values()
            .map(|loaded| loaded.plugin.manifest().clone())
            .collect()
    }

    pub async fn call(&self, id: &str, method: &str, params: Value) -> AppResult<Value> {
        let loaded = self.get(id)?;
        loaded
            .plugin
            .call(&loaded.context, method, params)
            .await
            .map_err(|error| AppError::Plugin {
                plugin: id.to_owned(),
                error,
            })
    }

    pub fn start_stream(
        &self,
        id: &str,
        method: String,
        params: Value,
        on_event: Channel<StreamEvent>,
    ) -> AppResult<u32> {
        let loaded = self.get(id)?;
        let plugin = Arc::clone(&loaded.plugin);
        let context = Arc::clone(&loaded.context);
        let stream_id = self.next_stream.fetch_add(1, Ordering::Relaxed);
        let streams = Arc::clone(&self.streams);
        let items = on_event.clone();
        let sink = StreamSink::new(move |value| items.send(StreamEvent::Item { value }).is_ok());
        let (registered, is_registered) = tokio::sync::oneshot::channel::<()>();
        let task = tauri::async_runtime::spawn(async move {
            if is_registered.await.is_err() {
                return;
            }
            let finished = plugin.stream(&context, &method, params, sink).await;
            let last = match finished {
                Ok(()) => StreamEvent::End,
                Err(error) if error.category == PluginError::stream_closed().category => {
                    StreamEvent::End
                }
                Err(error) => StreamEvent::Error { error },
            };
            let _ = on_event.send(last);
            streams.remove(&stream_id);
        });
        self.streams.insert(stream_id, task);
        let _ = registered.send(());
        Ok(stream_id)
    }

    pub fn stop_stream(&self, stream_id: u32) {
        if let Some((_, task)) = self.streams.remove(&stream_id) {
            task.abort();
        }
    }

    pub fn drain(&self) {
        let ids: Vec<u32> = self.streams.iter().map(|entry| *entry.key()).collect();
        for stream_id in ids {
            self.stop_stream(stream_id);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StreamEvent {
    Item { value: Value },
    End,
    Error { error: PluginError },
}

#[tauri::command]
pub fn plugin_manifests(host: tauri::State<'_, PluginHost>) -> Vec<Manifest> {
    host.manifests()
}

#[tauri::command]
pub async fn plugin_call(
    host: tauri::State<'_, PluginHost>,
    plugin: String,
    method: String,
    params: Value,
) -> AppResult<Value> {
    host.call(&plugin, &method, params).await
}

#[tauri::command]
pub async fn plugin_stream_start(
    host: tauri::State<'_, PluginHost>,
    plugin: String,
    method: String,
    params: Value,
    on_event: Channel<StreamEvent>,
) -> AppResult<u32> {
    host.start_stream(&plugin, method, params, on_event)
}

#[tauri::command]
pub async fn plugin_stream_stop(
    host: tauri::State<'_, PluginHost>,
    stream_id: u32,
) -> AppResult<()> {
    host.stop_stream(stream_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sikemux_plugin_api::PluginFuture;

    struct Echo(Manifest);

    impl Echo {
        fn plugin(id: &str, sikemux: &str) -> Arc<dyn Plugin> {
            let manifest = Manifest::from_json(
                &json!({ "id": id, "name": "Echo", "version": "1.0.0", "sikemux": sikemux, "group": "apis" }).to_string(),
            )
            .expect("test manifest parses");
            Arc::new(Self(manifest))
        }
    }

    impl Plugin for Echo {
        fn manifest(&self) -> &Manifest {
            &self.0
        }

        fn call<'a>(
            &'a self,
            _ctx: &'a PluginContext,
            method: &'a str,
            params: Value,
        ) -> PluginFuture<'a, Value> {
            Box::pin(async move {
                match method {
                    "echo" => Ok(params),
                    "fail" => {
                        Err(PluginError::new("unconfigured", "sign in first").with_status(401))
                    }
                    _ => Err(PluginError::unknown_method(method)),
                }
            })
        }
    }

    fn host(plugins: Vec<Arc<dyn Plugin>>) -> PluginHost {
        PluginHost::new(Path::new("/tmp/plugins"), &Version::new(0, 4, 0), plugins)
    }

    #[test]
    fn skips_incompatible_and_duplicate_plugins() {
        let host = host(vec![
            Echo::plugin("test.echo", ">=0.4"),
            Echo::plugin("test.echo", ">=0.4"),
            Echo::plugin("test.future", ">=9"),
        ]);
        let ids: Vec<String> = host.manifests().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["test.echo"]);
    }

    #[tokio::test]
    async fn routes_calls_and_tags_errors_with_the_plugin() {
        let host = host(vec![Echo::plugin("test.echo", "*")]);
        assert_eq!(
            host.call("test.echo", "echo", json!({ "a": 1 })).await.ok(),
            Some(json!({ "a": 1 }))
        );

        let error = host
            .call("test.echo", "fail", Value::Null)
            .await
            .expect_err("fails");
        let wire = serde_json::to_value(&error).expect("serializes");
        assert_eq!(
            wire,
            json!({ "category": "unconfigured", "message": "test.echo: sign in first", "status": 401, "plugin": "test.echo" })
        );

        let missing = host
            .call("test.nope", "echo", Value::Null)
            .await
            .expect_err("fails");
        assert_eq!(
            serde_json::to_value(&missing).expect("serializes")["category"],
            "not-installed"
        );
    }
}
