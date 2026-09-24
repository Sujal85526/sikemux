use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::client;
use crate::error::SignozResult;
use crate::query::{self, quote};

const MAX_SERVICES: u32 = 200;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceQuery {
    pub minutes: Option<u32>,
    /// Only these services, when given.
    #[serde(default)]
    pub services: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealth {
    pub service: String,
    pub calls: u64,
    pub errors: u64,
    pub error_rate: f64,
    pub p99_ms: f64,
}

/// Counted from entry spans rather than SigNoz's service map, which leaves out
/// services that still send traces.
pub async fn health(data_dir: &Path, request: ServiceQuery) -> SignozResult<Vec<ServiceHealth>> {
    let credentials = client::credentials(data_dir).await?;
    let only: Vec<String> = request
        .services
        .iter()
        .map(|service| quote(service))
        .collect();
    let expression = query::all_of(
        [
            Some("isRoot = true OR isEntryPoint = true".to_string()),
            (!only.is_empty()).then(|| format!("service.name IN ({})", only.join(", "))),
        ]
        .into_iter()
        .flatten(),
    );
    let spec = json!({
        "signal": "traces",
        "aggregations": [
            { "expression": "count()" },
            { "expression": "countIf(hasError = true)" },
            { "expression": "p99(duration_nano)" },
        ],
        "groupBy": [{ "name": "service.name", "fieldContext": "resource" }],
        "order": [{ "key": { "name": "count()" }, "direction": "desc" }],
        "limit": MAX_SERVICES,
    });
    let result = client::query_range(
        &credentials,
        &query::builder(
            "scalar",
            query::window(request.minutes),
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
            let calls = number(row.get(1)).max(0.0) as u64;
            let errors = number(row.get(2)).max(0.0) as u64;
            Some(ServiceHealth {
                service,
                calls,
                errors,
                error_rate: if calls == 0 {
                    0.0
                } else {
                    errors as f64 / calls as f64
                },
                p99_ms: number(row.get(3)) / 1_000_000.0,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_scalar_rows_signoz_returns() {
        let result =
            json!({ "data": [["reel-worker", 13861, 1, 1567176.99], ["idle", 0, 0, 0], ["bad"]] });
        let health = parse(&result);
        assert_eq!(health.len(), 3);
        assert_eq!(health[0].service, "reel-worker");
        assert!((health[0].p99_ms - 1.567_176_99).abs() < 1e-9);
        assert!((health[0].error_rate - 1.0 / 13861.0).abs() < 1e-12);
        assert_eq!(health[1].error_rate, 0.0);
        assert_eq!(health[2].calls, 0);
    }
}
