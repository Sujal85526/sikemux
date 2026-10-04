// Running SQL against a saved database, and keeping each run in its history.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::connections::{Access, Pool};
use crate::error::{DatabaseError, DatabaseResult};
use crate::history::{self, Entry, Source};
use crate::profiles;
use crate::values::{self, QueryOutcome};

/// How long an agent's statement may run before it is stopped, so a runaway query cannot hold the database.
const AGENT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub id: String,
    pub sql: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// Runs the SQL and adds it to the database's history, failed or not.
pub async fn run(
    pool: &Pool,
    data_dir: &Path,
    request: QueryRequest,
    source: Source,
) -> DatabaseResult<QueryOutcome> {
    let sql = request.sql.trim().to_string();
    if sql.is_empty() {
        return Err(DatabaseError::BadArg("there is no SQL to run".into()));
    }
    let access = match source {
        Source::Person => Access::Person,
        Source::Agent => Access::Agent,
    };
    let session = pool.session(data_dir, &request.id, access).await?;
    let started = Instant::now();
    let limit = values::row_limit(request.limit);
    let ran = match access {
        Access::Person => session.query(&sql, limit).await,
        Access::Agent => {
            match tokio::time::timeout(AGENT_TIMEOUT, session.query(&sql, limit)).await {
                Ok(ran) => ran,
                Err(_) => {
                    let _ = session.cancel().await;
                    Err(DatabaseError::Query(format!(
                        "stopped after {}s; agents' queries are limited to that",
                        AGENT_TIMEOUT.as_secs()
                    )))
                }
            }
        }
    };
    let outcome = ran.map(|results| QueryOutcome {
        results,
        millis: values::elapsed_millis(started),
    });
    let entry = Entry {
        sql,
        at: history::now_millis(),
        millis: values::elapsed_millis(started),
        ok: outcome.is_ok(),
        rows: outcome.as_ref().ok().and_then(rows_of_last),
        error: outcome.as_ref().err().map(ToString::to_string),
        source,
    };
    let dir = data_dir.to_path_buf();
    let id = request.id;
    let _ = profiles::blocking(move || history::record(&dir, &id, entry)).await;
    outcome
}

fn rows_of_last(outcome: &QueryOutcome) -> Option<u64> {
    let last = outcome.results.last()?;
    last.affected
        .or_else(|| u64::try_from(last.rows.len()).ok())
}

/// Stops the query running on the saved database's open connection. With none open there is nothing to stop.
pub async fn cancel(pool: &Pool, id: &str) -> DatabaseResult<()> {
    match pool.running(id).await {
        Some(session) => session.cancel().await,
        None => Ok(()),
    }
}
