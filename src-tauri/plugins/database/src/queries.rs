// Running SQL against a saved database, and keeping each run in its history.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::connections::{Access, Pool};
use crate::engines::Session;
use crate::error::{DatabaseError, DatabaseResult};
use crate::history::{self, Entry, Source};
use crate::profiles;
use crate::values::{self, QueryOutcome, ResultSet};

/// How long an agent's statement may run before it is stopped, so a runaway query cannot hold the database.
const AGENT_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a stopped query has to wind down and roll back.
const STOP_GRACE: Duration = Duration::from_secs(10);

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
    let (session, read_only) = pool.session_and_mode(data_dir, &request.id, access).await?;
    let started = Instant::now();
    let limit = values::row_limit(request.limit);
    let ran = match access {
        Access::Person => session.query(&sql, limit).await,
        Access::Agent => agent_run(session, sql.clone(), limit, read_only).await,
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

/// Runs an agent's SQL on a task of its own, so a call dropped halfway, as when the agent's turn is interrupted,
/// still finishes and rolls back. A query past the time limit is stopped, and its connection is not used again.
async fn agent_run(
    session: Session,
    sql: String,
    limit: usize,
    read_only: bool,
) -> DatabaseResult<Vec<ResultSet>> {
    let running = tokio::spawn(async move {
        let query = agent_query(&session, &sql, limit, read_only);
        let mut query = std::pin::pin!(query);
        tokio::select! {
            ran = &mut query => ran,
            () = tokio::time::sleep(AGENT_TIMEOUT) => {
                let _ = session.cancel().await;
                let _ = tokio::time::timeout(STOP_GRACE, query).await;
                session.retire();
                Err(DatabaseError::Query(format!(
                    "stopped after {}s; agents' queries are limited to that",
                    AGENT_TIMEOUT.as_secs()
                )))
            }
        }
    });
    running
        .await
        .map_err(|error| DatabaseError::Query(error.to_string()))?
}

/// An agent on a read-only connection gets the guarded path, so no statement can switch read-only off for another.
async fn agent_query(
    session: &Session,
    sql: &str,
    limit: usize,
    read_only: bool,
) -> DatabaseResult<Vec<ResultSet>> {
    if read_only {
        session.query_guarded(sql, limit).await
    } else {
        session.query(sql, limit).await
    }
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
