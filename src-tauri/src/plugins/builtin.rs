use std::sync::Arc;

use sikemux_plugin_api::Plugin;

pub fn plugins() -> Vec<Arc<dyn Plugin>> {
    Vec::new()
}
