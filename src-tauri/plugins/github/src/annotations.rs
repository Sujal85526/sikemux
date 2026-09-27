// Why a job failed, in the words GitHub puts at the top of a run: a file, a
// line and a message. Each job is also a check run, and the annotations hang
// off that, so a job's id is not the id this needs.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::client;
use crate::error::ActionsResult;
use crate::workflows::RepoRef;

const MAX_PER_PAGE: u32 = 100;

#[derive(Deserialize)]
struct AnnotationRow {
    path: Option<String>,
    start_line: Option<u64>,
    end_line: Option<u64>,
    annotation_level: Option<String>,
    title: Option<String>,
    message: Option<String>,
    raw_details: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    /// The file it points at, relative to the repository root. `.github` when
    /// the failure belongs to the workflow itself rather than to code.
    pub path: Option<String>,
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
    /// `failure`, `warning` or `notice`.
    pub level: String,
    pub title: Option<String>,
    pub message: String,
    pub details: Option<String>,
}

impl From<AnnotationRow> for Annotation {
    fn from(row: AnnotationRow) -> Self {
        Self {
            // GitHub uses this path for a failure that belongs to no file.
            path: row.path.filter(|path| path != ".github"),
            start_line: row.start_line,
            end_line: row.end_line,
            level: row.annotation_level.unwrap_or_else(|| "notice".into()),
            title: row.title,
            message: row.message.unwrap_or_default(),
            details: row.raw_details.filter(|text| !text.is_empty()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub check_run_id: u64,
}

pub async fn list(data_dir: &Path, input: Request) -> ActionsResult<Vec<Annotation>> {
    let path = input
        .repo
        .path(&format!("/check-runs/{}/annotations", input.check_run_id))?;
    let rows: Vec<AnnotationRow> =
        client::get(data_dir, &path, &[("per_page", MAX_PER_PAGE.to_string())]).await?;
    Ok(rows.into_iter().map(Annotation::from).collect())
}

/// The check run behind a job, which its `check_run_url` names. Only the
/// trailing number is needed, and only when it looks like one.
pub fn check_run_id(url: &str) -> Option<u64> {
    url.rsplit('/').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_check_run_a_job_points_at() {
        assert_eq!(
            check_run_id("https://api.github.com/repos/a/b/check-runs/123456"),
            Some(123_456)
        );
        assert_eq!(
            check_run_id("https://api.github.com/repos/a/b/check-runs/"),
            None
        );
        assert_eq!(check_run_id("not a url"), None);
    }

    #[test]
    fn a_failure_with_no_file_carries_no_path() {
        let row: AnnotationRow = serde_json::from_value(json!({
            "path": ".github", "start_line": 1, "end_line": 1,
            "annotation_level": "failure", "message": "Process completed with exit code 1.",
        }))
        .expect("parses");
        let annotation = Annotation::from(row);
        assert_eq!(annotation.path, None);
        assert_eq!(annotation.level, "failure");
    }

    #[test]
    fn keeps_the_file_and_line_of_a_real_one() {
        let row: AnnotationRow = serde_json::from_value(json!({
            "path": "src/lib.rs", "start_line": 12, "end_line": 12,
            "annotation_level": "failure", "title": "clippy",
            "message": "unused variable", "raw_details": "",
        }))
        .expect("parses");
        let annotation = Annotation::from(row);
        assert_eq!(annotation.path.as_deref(), Some("src/lib.rs"));
        assert_eq!(annotation.start_line, Some(12));
        assert_eq!(annotation.details, None);
    }
}
