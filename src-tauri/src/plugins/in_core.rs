//! The built-in plugins in the core's own process, so what the board does on
//! code hosts and trackers goes on while the app is closed.

use std::path::Path;

use serde_json::Value;
use sikemux_core::server::plugins::{PluginCall, Plugins};

use super::PluginHost;

struct InCore(PluginHost);

impl Plugins for InCore {
    fn call<'a>(&'a self, plugin: &'a str, method: &'a str, params: Value) -> PluginCall<'a> {
        Box::pin(async move {
            self.0.read_disabled();
            self.0
                .call(plugin, method, params)
                .await
                .map_err(|error| match error {
                    crate::error::AppError::Plugin { error, .. } => error.message,
                    other => other.to_string(),
                })
        })
    }
}

/// Gives the core the plugins, which keep their sign-ins under `data_dir`
/// as the app's do.
pub fn provide_to_core(data_dir: &Path) {
    crate::install_tls_crypto();
    let Ok(version) = semver::Version::parse(env!("CARGO_PKG_VERSION")) else {
        return;
    };
    match PluginHost::with_builtins(&data_dir.join("plugins"), &version) {
        Ok(host) => sikemux_core::server::plugins::provide(Box::new(InCore(host))),
        Err(error) => eprintln!("sikemux core: the built-in plugins did not load: {error}"),
    }
}
