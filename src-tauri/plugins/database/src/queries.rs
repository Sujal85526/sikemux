// Running SQL a person typed against a saved database.

use std::path::Path;
use std::time::Instant;

use serde::Deserialize;

use crate::connections::Pool;
use crate::error::{DatabaseError, DatabaseResult};
use crate::values::{self, QueryOutcome};

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub id: String,
    pub sql: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

pub async fn run(
    pool: &Pool,
    data_dir: &Path,
    request: QueryRequest,
) -> DatabaseResult<QueryOutcome> {
    let sql = request.sql.trim();
    if sql.is_empty() {
        return Err(DatabaseError::BadArg("there is no SQL to run".into()));
    }
    let session = pool.session(data_dir, &request.id).await?;
    let started = Instant::now();
    let results = session.query(sql, values::row_limit(request.limit)).await?;
    Ok(QueryOutcome {
        results,
        millis: values::elapsed_millis(started),
    })
}

/// Stops the query running on the saved database's open connection. With none open there is nothing to stop.
pub async fn cancel(pool: &Pool, id: &str) -> DatabaseResult<()> {
    match pool.running(id).await {
        Some(session) => session.cancel().await,
        None => Ok(()),
    }
}
