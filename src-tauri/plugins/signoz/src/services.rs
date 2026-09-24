use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::client;
use crate::error::SignozResult;
use crate::filter::Scope;
use crate::query;

const MAX_ROWS: u32 = 500;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceQuery {
    /// Narrows by environment and window. A service or filter here would
    /// hide the very rows the list is for, so those are ignored.
    #[serde(flatten)]
    pub scope: Scope,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealth {
    pub service: String,
    pub environment: Option<String>,
    pub calls: u64,
    pub errors: u64,
    pub error_rate: f64,
    pub p99_ms: f64,
}

/// Counted from entry spans rather than SigNoz's service map, which leaves out
/// services that still send traces. One row per service in each environment,
/// since the same service often runs in several.
pub async fn health(data_dir: &Path, request: ServiceQuery) -> SignozResult<Vec<ServiceHealth>> {
    let scope = Scope {
        environment: request.scope.environment.clone(),
        ..Scope::default()
    };
    let expression = query::all_of(
        std::iter::once("isRoot = true OR isEntryPoint = true".to_string()).chain(scope.clauses()?),
    );
    let spec = json!({
        "signal": "traces",
        "aggregations": [
            { "expression": "count()" },
            { "expression": "countIf(hasError = true)" },
            { "expression": "p99(duration_nano)" },
        ],
        "groupBy": [
            { "name": "service.name", "fieldContext": "resource" },
            { "name": "deployment.environment", "fieldContext": "resource" },
        ],
        "order": [{ "key": { "name": "count()" }, "direction": "desc" }],
        "limit": MAX_ROWS,
    });
    let result = client::query_range(
        data_dir,
        &query::builder(
            "scalar",
            request.scope.window(),
            query::with_filter(spec, expression),
        ),
    )
    .await?;
    Ok(parse(&result))
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.0)
}

fn parse(result: &Value) -> Vec<ServiceHealth> {
    let rows = result
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    rows.iter()
        .filter_map(|row| {
            let row = row.as_array()?;
            let service = row.first()?.as_str()?.to_string();
            let environment = row
                .get(1)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|environment| !environment.is_empty())
                .map(str::to_string);
            let calls = number(row.get(2)).max(0.0) as u64;
            let errors = number(row.get(3)).max(0.0) as u64;
            Some(ServiceHealth {
                service,
                environment,
                calls,
                errors,
                error_rate: if calls == 0 {
                    0.0
                } else {
                    errors as f64 / calls as f64
                },
                p99_ms: number(row.get(4)) / 1_000_000.0,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_one_row_per_service_and_environment() {
        let result = json!({ "data": [
            ["reel-worker", "production", 9066, 1, 1567176.99],
            ["reel-worker", "dev", 4874, 0, 0],
            ["no-env", "", 3, 0, 1000000],
            ["bad"],
        ] });
        let health = parse(&result);
        assert_eq!(health.len(), 4);
        assert_eq!(health[0].environment.as_deref(), Some("production"));
        assert!((health[0].p99_ms - 1.567_176_99).abs() < 1e-9);
        assert!((health[0].error_rate - 1.0 / 9066.0).abs() < 1e-12);
        assert_eq!(health[1].error_rate, 0.0);
        assert_eq!(health[2].environment, None);
        assert_eq!(health[3].calls, 0);
    }
}
