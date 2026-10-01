use std::time::Duration;

use tauri::ipc::{Channel, Response};
use tauri::State;

use sikemux_pty::screen::{attach_snapshot_with_compaction, MAX_ATTACH_SNAPSHOT_BYTES};
use sikemux_pty::shell_protocol::{ShellMetadataSnapshot, ShellProtocolParser};

use crate::error::{AppError, AppResult};
use crate::observability::{global_observability, Metadata, SpanOutcome};

use super::output::insert_subscriber;
use super::{pty_err, Pty, PtyManager, MAX_PTY_SUBSCRIBERS_PER_PTY, NEXT_SUB_ID};

/// Everything about an attach except the replay bytes, which follow the
/// header in the same raw response instead of crossing as JSON numbers.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachResult {
    pub sub_id: u32,
    pub alternate_screen: bool,
    /// Latest headless shell state, present only for an explicitly enabled,
    /// supported local shell. This lets a remounted frontend recover metadata
    /// even though historical OSC bytes are intentionally not replayed.
    pub shell: Option<ShellMetadataSnapshot>,
}

/// `[header length as 4 little-endian bytes][header JSON][replay bytes]`.
fn encode_attach_response(header: &AttachResult, snapshot: Vec<u8>) -> AppResult<Vec<u8>> {
    let json = serde_json::to_vec(header)?;
    let mut body = Vec::with_capacity(4 + json.len() + snapshot.len());
    body.extend_from_slice(&(json.len() as u32).to_le_bytes());
    body.extend_from_slice(&json);
    body.extend_from_slice(&snapshot);
    Ok(body)
}

/// Atomic snapshot + subscribe. The parser lock is held while we both
/// capture the screen contents AND insert the subscriber into the
/// fan-out map, so the reader task (which holds parser → broadcast in
/// the same nested order) cannot interleave a byte that ends up both in
/// the snapshot and in the channel — or one that's in neither.
///
/// `snapshot` is the visible screen + scrollback plus input modes as an
/// ANSI byte stream. Writing it to a fresh xterm reproduces the visual
/// state and the mode state that affects input/wheel handling at the
/// moment of the call. The native byte budget is authoritative: oversized
/// history is compacted to a newest suffix under this same parser lock, while
/// an oversized live viewport fails before a subscriber is registered.
fn attach_locked(pty: &Pty, on_event: Channel<Response>) -> AppResult<Vec<u8>> {
    let mut parser = pty.parser.lock().map_err(pty_err)?;
    let alternate_screen = parser.screen().alternate_screen();
    let mut subs = pty.subscribers.lock().map_err(pty_err)?;
    if subs.len() >= MAX_PTY_SUBSCRIBERS_PER_PTY {
        return Err(AppError::Pty("PTY subscriber capacity reached".into()));
    }
    // Make a bounded replay the authoritative parser state when history
    // must be truncated, so repeated attaches do not repeatedly scan
    // discarded history. Output cannot interleave because parser ->
    // subscribers is the reader/broadcast lock order too.
    let snapshot = attach_snapshot_with_compaction(&mut parser, MAX_ATTACH_SNAPSHOT_BYTES)?;
    let shell = parser
        .callbacks()
        .shell
        .as_ref()
        .map(ShellProtocolParser::snapshot);
    let sub_id = insert_subscriber(&mut subs, &NEXT_SUB_ID, on_event)?;
    drop(subs);
    drop(parser);
    encode_attach_response(
        &AttachResult {
            sub_id,
            alternate_screen,
            shell,
        },
        snapshot,
    )
}

#[tauri::command]
pub async fn pty_attach(
    manager: State<'_, PtyManager>,
    id: u32,
    on_event: Channel<Response>,
) -> AppResult<Response> {
    let observer = global_observability();
    let operation = observer.slow_operation(
        "pty.attach",
        Duration::from_millis(16),
        None,
        Metadata::new(),
    );
    // Clone the Arc out of DashMap so no shard is held across the await.
    let pty = manager
        .ptys
        .get(&id)
        .map(|entry| entry.value().clone())
        .ok_or(AppError::BadArg("pty not found"));
    let result = match pty {
        Ok(pty) => tauri::async_runtime::spawn_blocking(move || attach_locked(&pty, on_event))
            .await
            .map_err(|e| AppError::Pty(format!("pty_attach join: {e}")))
            .and_then(|body| body),
        Err(error) => Err(error),
    };
    operation.finish(if result.is_ok() {
        SpanOutcome::Success
    } else {
        SpanOutcome::Error
    });
    result.map(Response::new)
}

const RESET_MODES: &[u8] = b"\x1b>\x1b[4l\x1b[?1l\x1b[?6l\x1b[?7h\x1b[?9l\x1b[?45l\x1b[?66l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?2004l\x1b[?1049l";

#[tauri::command]
pub async fn pty_reset_modes(manager: State<'_, PtyManager>, id: u32) -> AppResult<()> {
    let pty = manager
        .ptys
        .get(&id)
        .map(|entry| entry.value().clone())
        .ok_or(AppError::BadArg("pty not found"))?;
    tauri::async_runtime::spawn_blocking(move || reset_modes_locked(&pty))
        .await
        .map_err(|e| AppError::Pty(format!("pty_reset_modes join: {e}")))?
}

fn reset_modes_locked(pty: &Pty) -> AppResult<()> {
    let mut parser = pty.parser.lock().map_err(pty_err)?;
    parser.process(RESET_MODES);
    // Queue the exact same bytes to every attached xterm while the parser
    // lock is still held. The reader cannot process and broadcast newer PTY
    // output until this reset is queued, so frontend and backend mode state
    // cannot be reordered around a concurrent child write.
    let mut dead = Vec::new();
    {
        let subscribers = pty.subscribers.lock().map_err(pty_err)?;
        for (sub_id, subscriber) in subscribers.iter() {
            if !subscriber.send(RESET_MODES) {
                dead.push(*sub_id);
            }
        }
    }
    drop(parser);
    if !dead.is_empty() {
        let mut subscribers = pty.subscribers.lock().map_err(pty_err)?;
        for sub_id in dead {
            subscribers.remove(&sub_id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{encode_attach_response, AttachResult, RESET_MODES};
    use sikemux_pty::screen::PARSER_SCROLLBACK;

    #[test]
    fn attach_response_frames_the_header_before_the_replay_bytes() {
        let header = AttachResult {
            sub_id: 9,
            alternate_screen: false,
            shell: None,
        };
        let body = encode_attach_response(&header, b"hello".to_vec()).expect("encode attach");
        let header_len = u32::from_le_bytes(body[..4].try_into().expect("length prefix")) as usize;
        let parsed: serde_json::Value =
            serde_json::from_slice(&body[4..4 + header_len]).expect("header json");
        assert_eq!(parsed["subId"], 9);
        assert_eq!(parsed["alternateScreen"], false);
        assert_eq!(&body[4 + header_len..], b"hello");
    }

    #[test]
    fn reset_modes_disables_interaction_modes_without_losing_normal_history() {
        let mut parser = vt100::Parser::new(5, 20, PARSER_SCROLLBACK);
        for i in 0..20 {
            parser.process(format!("line {i:02}\r\n").as_bytes());
        }
        parser.process(
            b"\x1b=\x1b[?1h\x1b[?9h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1005h\x1b[?1006h\x1b[?2004h\x1b[?1049halt",
        );
        parser.process(RESET_MODES);

        assert!(!parser.screen().alternate_screen());
        assert!(!parser.screen().application_keypad());
        assert!(!parser.screen().application_cursor());
        assert!(!parser.screen().bracketed_paste());
        assert_eq!(
            parser.screen().mouse_protocol_mode(),
            vt100::MouseProtocolMode::None
        );
        assert_eq!(
            parser.screen().mouse_protocol_encoding(),
            vt100::MouseProtocolEncoding::Default
        );
        let screen = parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        assert!(screen.contents().contains("line 00"));
    }
}
