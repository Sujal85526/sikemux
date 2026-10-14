//! The app's built-in plugins, as the core reaches them to act on code hosts
//! and trackers with the person's own sign-ins while the window is closed.
//! The binary that runs the core provides them; without them, as in tests,
//! every call says they are missing.

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use serde_json::Value;

pub type PluginCall<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

pub trait Plugins: Send + Sync {
    fn call<'a>(&'a self, plugin: &'a str, method: &'a str, params: Value) -> PluginCall<'a>;
}

static PLUGINS: OnceLock<Box<dyn Plugins>> = OnceLock::new();

/// Gives the core its plugins. Call once, before the core starts.
pub fn provide(plugins: Box<dyn Plugins>) {
    let _ = PLUGINS.set(plugins);
}

pub(crate) async fn call(plugin: &str, method: &str, params: Value) -> Result<Value, String> {
    match PLUGINS.get() {
        Some(plugins) => plugins.call(plugin, method, params).await,
        None => Err(format!(
            "Sikemux's {plugin} plugin is not available to its background process"
        )),
    }
}
