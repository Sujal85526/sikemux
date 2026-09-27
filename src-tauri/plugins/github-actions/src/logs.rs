// A job's log. GitHub keeps them behind a redirect to storage and only for a
// while, so a log that has aged out reads as missing rather than as an error
// nobody can act on.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::client;
use crate::error::{ActionsError, ActionsResult};
use crate::runs::JobRef;

/// Every log line carries the time the runner wrote it, ahead of a space.
/// Fractional seconds are usually there but not always, so only the part
/// every stamp has is counted on.
const SHORTEST_STAMP: usize = "2026-01-01T00:00:00Z".len();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub number: u64,
    pub timestamp: Option<String>,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLog {
    pub lines: Vec<LogLine>,
    /// True once a log has aged out of GitHub's retention, so nothing is coming.
    pub expired: bool,
}

/// Runner logs start every line with a timestamp. Splitting it off lets the
/// view show the text on its own and the time beside it.
fn split_stamp(line: &str) -> (Option<String>, &str) {
    let Some((head, rest)) = line.split_once(' ') else {
        return (None, line);
    };
    let looks_like_a_stamp = head.len() >= SHORTEST_STAMP
        && head.ends_with('Z')
        && head.get(4..5) == Some("-")
        && head.get(10..11) == Some("T");
    if looks_like_a_stamp {
        (Some(head.to_string()), rest)
    } else {
        (None, line)
    }
}

fn parse(text: &str) -> Vec<LogLine> {
    text.lines()
        .enumerate()
        .map(|(index, line)| {
            let (timestamp, text) = split_stamp(line.trim_end_matches('\r'));
            LogLine {
                number: index as u64 + 1,
                timestamp,
                text: text.to_string(),
            }
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRequest {
    #[serde(flatten)]
    pub job: JobRef,
}

pub async fn job(data_dir: &Path, input: LogRequest) -> ActionsResult<JobLog> {
    let path = input
        .job
        .repo
        .path(&format!("/actions/jobs/{}/logs", input.job.job_id))?;
    match client::download_text(data_dir, &path).await {
        Ok(text) => Ok(JobLog {
            lines: parse(&text),
            expired: false,
        }),
        Err(ActionsError::NotFound(_)) | Err(ActionsError::Http { status: 410, .. }) => {
            Ok(JobLog {
                lines: Vec::new(),
                expired: true,
            })
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifts_the_runners_timestamp_off_each_line() {
        let (stamp, text) = split_stamp("2026-01-01T00:00:00.1234567Z Run actions/checkout@v4");
        assert_eq!(stamp.as_deref(), Some("2026-01-01T00:00:00.1234567Z"));
        assert_eq!(text, "Run actions/checkout@v4");
    }

    #[test]
    fn a_stamp_without_fractional_seconds_is_still_a_stamp() {
        let (stamp, text) = split_stamp("2026-01-01T00:00:00Z building");
        assert_eq!(stamp.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(text, "building");
    }

    #[test]
    fn a_line_without_one_keeps_all_its_text() {
        for line in ["plain output", "", "not-a-stamp rest", "##[group]Setup"] {
            let (stamp, text) = split_stamp(line);
            assert_eq!(stamp, None, "{line}");
            assert_eq!(text, line, "{line}");
        }
    }

    #[test]
    fn numbers_lines_from_one_and_drops_carriage_returns() {
        let lines = parse("2026-01-01T00:00:00Z first\r\nsecond\r\n");
        let shown: Vec<(u64, &str)> = lines
            .iter()
            .map(|line| (line.number, line.text.as_str()))
            .collect();
        assert_eq!(shown, [(1, "first"), (2, "second")]);
    }
}
