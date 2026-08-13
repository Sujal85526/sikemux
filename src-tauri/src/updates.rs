use std::time::{Duration, Instant};

use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::{Updater, UpdaterExt};

use crate::error::{AppError, AppResult};
use crate::observability::{global_observability, Metadata, ScalarValue, SpanContext, SpanOutcome};

const STABLE_ENDPOINT: &str =
    "https://github.com/nodelike/sikemux/releases/latest/download/latest.json";
const PREVIEW_ENDPOINT: &str =
    "https://github.com/nodelike/sikemux/releases/download/preview/latest.json";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(250);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum UpdateInstallPhase {
    Downloading,
    Installing,
    Installed,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallProgress {
    phase: UpdateInstallPhase,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Debug, Default)]
struct DownloadProgressReporter {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    last_emitted_at: Option<Instant>,
}

impl DownloadProgressReporter {
    fn snapshot(&self, phase: UpdateInstallPhase) -> UpdateInstallProgress {
        UpdateInstallProgress {
            phase,
            downloaded_bytes: self.downloaded_bytes,
            total_bytes: self.total_bytes,
        }
    }

    fn observe(
        &mut self,
        chunk_length: usize,
        content_length: Option<u64>,
        now: Instant,
    ) -> Option<UpdateInstallProgress> {
        let chunk_length = u64::try_from(chunk_length).unwrap_or(u64::MAX);
        self.downloaded_bytes = self.downloaded_bytes.saturating_add(chunk_length);
        if content_length.is_some() {
            self.total_bytes = content_length;
        }

        let complete = self
            .total_bytes
            .is_some_and(|total| self.downloaded_bytes >= total);
        let due = self
            .last_emitted_at
            .is_none_or(|last| now.saturating_duration_since(last) >= PROGRESS_EVENT_INTERVAL);
        if !complete && !due {
            return None;
        }

        self.last_emitted_at = Some(now);
        Some(self.snapshot(UpdateInstallPhase::Downloading))
    }
}

fn updater(app: &AppHandle, channel: &str, timeout: Duration) -> AppResult<Updater> {
    let endpoint = match channel {
        "stable" => STABLE_ENDPOINT,
        "preview" => PREVIEW_ENDPOINT,
        _ => return Err(AppError::BadArg("update channel must be stable or preview")),
    };
    let url = endpoint
        .parse()
        .map_err(|error| AppError::Other(format!("update endpoint: {error}")))?;
    app.updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| builder.timeout(timeout).build())
        .map_err(|error| AppError::Other(format!("updater: {error}")))
}

#[tauri::command]
pub async fn update_check(app: AppHandle, channel: String) -> AppResult<Option<UpdateInfo>> {
    Ok(updater(&app, &channel, UPDATE_CHECK_TIMEOUT)?
        .check()
        .await
        .map_err(|error| AppError::Other(format!("update check: {error}")))?
        .map(|update| UpdateInfo {
            version: update.version,
            current_version: update.current_version,
            notes: update.body,
            date: update.date.map(|date| date.to_string()),
        }))
}

#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    channel: String,
    on_progress: Channel<UpdateInstallProgress>,
) -> AppResult<UpdateInfo> {
    let observer = global_observability();
    let mut metadata = Metadata::new();
    metadata.insert("channel".to_owned(), ScalarValue::from(channel.as_str()));
    let span = observer.begin_span("update.install", None, metadata);
    let context = span.context();

    let result = update_install_inner(&app, &channel, on_progress, context).await;
    let outcome = if result.is_ok() {
        let _ = observer.increment_counter("update.install.success", 1);
        SpanOutcome::Success
    } else {
        let _ = observer.increment_counter("update.install.errors", 1);
        SpanOutcome::Error
    };
    span.finish(outcome);
    result
}

async fn update_install_inner(
    app: &AppHandle,
    channel: &str,
    on_progress: Channel<UpdateInstallProgress>,
    context: SpanContext,
) -> AppResult<UpdateInfo> {
    let update = updater(app, channel, UPDATE_INSTALL_TIMEOUT)?
        .check()
        .await
        .map_err(|error| AppError::Other(format!("update check: {error}")))?
        .ok_or_else(|| AppError::Other("no update is available".into()))?;
    let installed = UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|date| date.to_string()),
    };

    let observer = global_observability();
    let mut download_metadata = Metadata::new();
    download_metadata.insert(
        "version".to_owned(),
        ScalarValue::from(installed.version.as_str()),
    );
    observer.record_event("update.download.started", Some(context), download_metadata);

    let mut progress = DownloadProgressReporter::default();
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if let Some(event) = progress.observe(chunk_length, content_length, Instant::now())
                {
                    let _ = on_progress.send(event);
                }
            },
            || {},
        )
        .await
        .map_err(|error| AppError::Other(format!("update install: {error}")))?;

    let mut downloaded_metadata = Metadata::new();
    downloaded_metadata.insert(
        "downloaded_bytes".to_owned(),
        ScalarValue::from(progress.downloaded_bytes),
    );
    if let Some(total_bytes) = progress.total_bytes {
        downloaded_metadata.insert("total_bytes".to_owned(), ScalarValue::from(total_bytes));
    }
    observer.record_event(
        "update.download.finished",
        Some(context),
        downloaded_metadata,
    );
    let _ = on_progress.send(progress.snapshot(UpdateInstallPhase::Downloading));
    let _ = on_progress.send(progress.snapshot(UpdateInstallPhase::Installing));
    observer.record_event("update.install.started", Some(context), Metadata::new());
    update
        .install(&bytes)
        .map_err(|error| AppError::Other(format!("update install: {error}")))?;
    observer.record_event("update.install.finished", Some(context), Metadata::new());
    let _ = on_progress.send(progress.snapshot(UpdateInstallPhase::Installed));
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn download_progress_reports_absolute_bounded_updates_and_completion() {
        let start = Instant::now();
        let mut reporter = DownloadProgressReporter::default();

        let first = reporter.observe(32, Some(100), start).unwrap();
        assert_eq!(first.downloaded_bytes, 32);
        assert_eq!(first.total_bytes, Some(100));
        assert!(reporter
            .observe(16, Some(100), start + Duration::from_millis(100))
            .is_none());

        let timed = reporter
            .observe(16, Some(100), start + PROGRESS_EVENT_INTERVAL)
            .unwrap();
        assert_eq!(timed.downloaded_bytes, 64);

        let complete = reporter
            .observe(36, Some(100), start + PROGRESS_EVENT_INTERVAL)
            .unwrap();
        assert_eq!(complete.downloaded_bytes, 100);
        assert_eq!(complete.phase, UpdateInstallPhase::Downloading);
    }

    #[test]
    fn progress_payload_uses_frontend_camel_case_contract() {
        let value = serde_json::to_value(UpdateInstallProgress {
            phase: UpdateInstallPhase::Installing,
            downloaded_bytes: 13_362_333,
            total_bytes: Some(13_362_333),
        })
        .unwrap();

        assert_eq!(
            value,
            json!({
                "phase": "installing",
                "downloadedBytes": 13_362_333,
                "totalBytes": 13_362_333
            })
        );
    }

    #[test]
    fn progress_byte_counter_saturates() {
        let start = Instant::now();
        let mut reporter = DownloadProgressReporter {
            downloaded_bytes: u64::MAX - 1,
            ..DownloadProgressReporter::default()
        };

        let progress = reporter.observe(10, None, start).unwrap();
        assert_eq!(progress.downloaded_bytes, u64::MAX);
    }
}
