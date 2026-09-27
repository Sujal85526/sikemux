// Follows one run while it is going. Every tick carries the whole run and its
// jobs, so even an unchanged tick tells the view the watch is still alive.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sikemux_plugin_api::{reply, PluginResult, StreamSink};
use tokio::time::sleep;

use crate::runs::{self, Job, Run, RunRef};
use crate::workflows::RepoRef;

const POLL_INTERVAL: Duration = Duration::from_secs(3);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const ERROR_GIVEUP: u32 = 6;
/// One more read after a run reports itself finished, so the last job's steps
/// arrive rather than the view stopping on a half-finished picture.
const SETTLE_POLLS: u32 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Tick {
    run: Option<Run>,
    jobs: Vec<Job>,
    error: Option<String>,
    finished: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub run_id: u64,
}

fn backoff(failures: u32) -> Duration {
    if failures == 0 {
        return POLL_INTERVAL;
    }
    let factor = 1u32 << failures.min(5);
    POLL_INTERVAL.saturating_mul(factor).min(MAX_BACKOFF)
}

pub async fn run(data_dir: &Path, input: Watch, sink: StreamSink) -> PluginResult<()> {
    let mut failures: u32 = 0;
    let mut settled: u32 = 0;
    loop {
        let reference = RunRef {
            repo: RepoRef {
                owner: input.repo.owner.clone(),
                name: input.repo.name.clone(),
            },
            run_id: input.run_id,
        };
        let (run, jobs, error) = match runs::detail(data_dir, reference).await {
            Ok(detail) => (Some(detail.run), detail.jobs, None),
            Err(error) => (None, Vec::new(), Some(error.to_string())),
        };
        failures = if error.is_some() {
            failures.saturating_add(1)
        } else {
            0
        };

        let run_over = run
            .as_ref()
            .is_some_and(|run| runs::is_finished(&run.status));
        let jobs_over = !jobs.is_empty() && jobs.iter().all(|job| runs::is_finished(&job.status));
        if run_over {
            settled = settled.saturating_add(1);
        } else {
            settled = 0;
        }
        let finished =
            (run_over && (jobs_over || settled > SETTLE_POLLS)) || failures >= ERROR_GIVEUP;

        sink.send(reply(Tick {
            run,
            jobs,
            error,
            finished,
        })?)?;
        if finished {
            return Ok(());
        }
        sleep(backoff(failures)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_healthy_watch_polls_at_a_steady_pace() {
        assert_eq!(backoff(0), POLL_INTERVAL);
    }

    #[test]
    fn failures_back_off_and_stop_growing_at_the_ceiling() {
        assert!(backoff(1) > backoff(0));
        assert!(backoff(3) > backoff(1));
        assert_eq!(backoff(20), MAX_BACKOFF);
    }
}
