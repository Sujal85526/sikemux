use std::hash::{Hash, Hasher};
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent_detection::{
    AgentDetection, DetectionExplain, DetectionInput, ManifestRegistry, ManifestReloadReport,
};
use crate::error::{AppError, AppResult};

use super::{now_ms, Pty, PtyManager, ACTIVITY_WORKING, MAIN_WEBVIEW, NEXT_ACTIVITY_SEQUENCE};

#[tauri::command]
pub async fn agent_detection_manifests(
    manager: State<'_, PtyManager>,
) -> AppResult<ManifestReloadReport> {
    manager
        .detection_registry
        .read()
        .map(|registry| registry.report())
        .map_err(|_| AppError::Other("agent detection registry lock poisoned".into()))
}

#[tauri::command]
pub async fn agent_detection_reload(
    app: AppHandle,
    manager: State<'_, PtyManager>,
) -> AppResult<ManifestReloadReport> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::Other(format!("agent detection config path: {error}")))?
        .join("agent-detection");
    let (replacement, report) = tauri::async_runtime::spawn_blocking(move || {
        let mut replacement = ManifestRegistry::with_override_dir(directory)
            .map_err(|error| AppError::Other(format!("agent detection manifests: {error}")))?;
        let report = replacement
            .reload()
            .map_err(|error| AppError::Other(format!("agent detection manifests: {error}")))?;
        Ok::<_, AppError>((replacement, report))
    })
    .await
    .map_err(|e| AppError::Other(format!("agent detection reload join: {e}")))??;
    *manager
        .detection_registry
        .write()
        .map_err(|_| AppError::Other("agent detection registry lock poisoned".into()))? =
        replacement;
    // The terminal evidence may be unchanged while the matching rules have
    // changed. Invalidate every settled scan so the new registry takes effect
    // on the next sweeper tick without requiring fresh PTY output.
    for entry in manager.ptys.iter() {
        entry
            .value()
            .last_detection_fingerprint
            .store(0, Ordering::Release);
        entry
            .value()
            .last_detection_revision
            .store(0, Ordering::Release);
    }
    Ok(report)
}

#[tauri::command]
pub async fn agent_detection_explain(
    manager: State<'_, PtyManager>,
    agent_id: String,
) -> AppResult<DetectionExplain> {
    let pty = manager
        .ptys
        .iter()
        .find(|entry| entry.value().activity_key.as_deref() == Some(agent_id.as_str()))
        .map(|entry| entry.value().clone())
        .ok_or(AppError::BadArg("agent has no live terminal"))?;
    let kind = pty
        .agent_kind
        .ok_or(AppError::BadArg("terminal has no known agent type"))?;
    let (recent, title) = tauri::async_runtime::spawn_blocking(move || {
        pty.parser
            .lock()
            .map(|parser| {
                (
                    parser.screen().contents(),
                    parser.callbacks().window_title.clone(),
                )
            })
            .map_err(|_| AppError::Other("agent terminal parser lock poisoned".into()))
    })
    .await
    .map_err(|e| AppError::Other(format!("agent detection explain join: {e}")))??;
    manager
        .detection_registry
        .read()
        .map(|registry| {
            let input = if title.is_empty() {
                DetectionInput::screen(&recent)
            } else {
                DetectionInput {
                    recent_screen: &recent,
                    osc_title: &title,
                    osc_progress: "",
                }
            };
            registry.explain(kind, input)
        })
        .map_err(|_| AppError::Other("agent detection registry lock poisoned".into()))
}

pub(super) fn semantic_fingerprint(revision: u64, screen: &str, title: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    revision.hash(&mut hasher);
    screen.hash(&mut hasher);
    title.hash(&mut hasher);
    // Zero is the initial "never evaluated" sentinel.
    hasher.finish().max(1)
}

fn event_fingerprint(
    state: u8,
    label: &str,
    source: &str,
    confidence: &str,
    reason: &str,
    matched_rule: Option<&str>,
) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    state.hash(&mut hasher);
    label.hash(&mut hasher);
    source.hash(&mut hasher);
    confidence.hash(&mut hasher);
    reason.hash(&mut hasher);
    matched_rule.hash(&mut hasher);
    hasher.finish().max(1)
}

pub(super) fn detection_reason(detection: &AgentDetection) -> String {
    if let Some(fallback) = detection.fallback_reason.as_deref() {
        return format!("agent detection fallback: {fallback}");
    }
    let Some(rule) = detection.matched_rule.as_deref() else {
        return format!(
            "agent screen evaluated with manifest {}",
            detection.manifest_version
        );
    };
    let evidence = &detection.evidence;
    let visible = if evidence.visible_blocker {
        "visible blocker"
    } else if evidence.visible_working {
        "visible working status"
    } else if evidence.visible_idle {
        "visible idle prompt"
    } else {
        "screen evidence"
    };
    match evidence.region.as_deref() {
        Some(region) => format!("manifest rule {rule} matched {visible} in {region}"),
        None => format!("manifest rule {rule} matched {visible}"),
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStateEvent<'a> {
    agent_id: &'a str,
    state: &'static str,
    sequence: u64,
    source: &'static str,
    confidence: &'static str,
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    matched_rule: Option<String>,
}

pub(super) fn publish_agent_state(
    pty: &Pty,
    next: u8,
    label: &'static str,
    source: &'static str,
    confidence: &'static str,
    reason: impl Into<String>,
    matched_rule: Option<String>,
) {
    if !pty.report_exit.load(Ordering::Acquire) {
        return;
    }
    let Some(agent_id) = pty.activity_key.as_deref() else {
        return;
    };
    let reason = reason.into();
    let fingerprint = event_fingerprint(
        next,
        label,
        source,
        confidence,
        &reason,
        matched_rule.as_deref(),
    );
    if pty
        .last_published_fingerprint
        .swap(fingerprint, Ordering::AcqRel)
        == fingerprint
    {
        return;
    }
    pty.activity_state.store(next, Ordering::Release);
    let sequence = NEXT_ACTIVITY_SEQUENCE.fetch_add(1, Ordering::AcqRel);
    let _ = pty.app.emit_to(
        MAIN_WEBVIEW,
        "agent_state_changed",
        AgentStateEvent {
            agent_id,
            state: label,
            sequence,
            source,
            confidence,
            reason,
            matched_rule,
        },
    );
}

pub(super) fn arm_agent_activity(pty: &Pty) {
    if pty.activity_key.is_none() {
        return;
    }
    pty.activity_armed.store(true, Ordering::Release);
    pty.last_activity_ms.store(now_ms(), Ordering::Relaxed);
    pty.idle_confirmations.store(0, Ordering::Release);
    pty.activity_revision.fetch_add(1, Ordering::AcqRel);
    publish_agent_state(
        pty,
        ACTIVITY_WORKING,
        "working",
        "activity",
        "high",
        "command submitted",
        None,
    );
}

pub(super) fn submits_line(data: &str) -> bool {
    data.contains('\r') || data.contains('\n')
}

pub(super) fn note_agent_output(pty: &Pty) {
    // Startup banners, model discovery, and the first TUI paint are output,
    // but they are not work. A fresh agent stays Ready until Sikemux observes
    // an actual submitted line. Once armed, output is meaningful activity.
    if pty.agent_kind.is_some() && pty.activity_armed.load(Ordering::Acquire) {
        pty.idle_confirmations.store(0, Ordering::Release);
        publish_agent_state(
            pty,
            ACTIVITY_WORKING,
            "working",
            "activity",
            "medium",
            "agent produced output",
            None,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{event_fingerprint, semantic_fingerprint, submits_line};

    #[test]
    fn only_submitted_input_arms_agent_activity() {
        assert!(submits_line("ship it\r"));
        assert!(submits_line("first\nsecond"));
        assert!(!submits_line("still typing"));
        assert!(!submits_line("\x1b[A"));
    }

    #[test]
    fn semantic_fingerprint_changes_with_evidence_or_revision() {
        let base = semantic_fingerprint(1, "prompt", "Codex");
        assert_eq!(base, semantic_fingerprint(1, "prompt", "Codex"));
        assert_ne!(base, semantic_fingerprint(2, "prompt", "Codex"));
        assert_ne!(base, semantic_fingerprint(1, "working", "Codex"));
        assert_ne!(base, semantic_fingerprint(1, "prompt", "Action required"));
    }

    #[test]
    fn event_fingerprint_preserves_same_state_evidence_upgrades() {
        let activity =
            event_fingerprint(1, "working", "activity", "high", "command submitted", None);
        let screen = event_fingerprint(
            1,
            "working",
            "screen",
            "high",
            "manifest rule spinner matched visible working status",
            Some("spinner"),
        );
        let changed_reason = event_fingerprint(
            1,
            "working",
            "screen",
            "high",
            "manifest rule tool matched visible working status",
            Some("tool"),
        );
        assert_ne!(activity, screen);
        assert_ne!(screen, changed_reason);
        assert_eq!(
            screen,
            event_fingerprint(
                1,
                "working",
                "screen",
                "high",
                "manifest rule spinner matched visible working status",
                Some("spinner")
            )
        );
    }
}
