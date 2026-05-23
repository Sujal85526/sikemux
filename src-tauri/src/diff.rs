// Server-side diff for the git gutter. Frontend ships (baseline, current);
// we return a flat list of line-range hunks tagged add/mod/del. Replaces the
// per-keystroke `presentableDiff` call in gitGutter.ts.

use serde::Serialize;
use similar::{ChangeTag, TextDiff};

#[derive(Serialize)]
pub struct DiffHunk {
    pub kind: &'static str, // "add" | "mod" | "del"
    pub start: u32,         // 0-based line in `current`
    pub end: u32,           // exclusive; for "del" equals start
}

#[tauri::command]
pub fn diff_hunks(baseline: String, current: String) -> Vec<DiffHunk> {
    if baseline == current {
        return Vec::new();
    }
    let diff = TextDiff::from_lines(&baseline, &current);
    let mut out: Vec<DiffHunk> = Vec::new();
    let mut cur_line: u32 = 0; // 0-based line in `current`
    let mut run_add_start: Option<u32> = None;
    let mut run_del_at: Option<u32> = None;

    // We coalesce a sequence of inserts touching the same lines into one
    // "add" hunk, and group an insert immediately following a delete into a
    // "mod" hunk on the inserted lines.
    let mut last_was_delete = false;
    let mut pending_mod_start: Option<u32> = None;

    fn flush_add(out: &mut Vec<DiffHunk>, start: &mut Option<u32>, end: u32) {
        if let Some(s) = start.take() {
            out.push(DiffHunk { kind: "add", start: s, end });
        }
    }
    fn flush_mod(out: &mut Vec<DiffHunk>, start: &mut Option<u32>, end: u32) {
        if let Some(s) = start.take() {
            out.push(DiffHunk { kind: "mod", start: s, end });
        }
    }
    fn flush_del(out: &mut Vec<DiffHunk>, at: &mut Option<u32>) {
        if let Some(a) = at.take() {
            out.push(DiffHunk { kind: "del", start: a, end: a });
        }
    }

    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Equal => {
                flush_add(&mut out, &mut run_add_start, cur_line);
                flush_mod(&mut out, &mut pending_mod_start, cur_line);
                flush_del(&mut out, &mut run_del_at);
                last_was_delete = false;
                cur_line += 1;
            }
            ChangeTag::Delete => {
                flush_add(&mut out, &mut run_add_start, cur_line);
                flush_mod(&mut out, &mut pending_mod_start, cur_line);
                if run_del_at.is_none() {
                    run_del_at = Some(cur_line);
                }
                last_was_delete = true;
            }
            ChangeTag::Insert => {
                if last_was_delete {
                    // turn pending del + this insert into a "mod" run
                    run_del_at = None;
                    if pending_mod_start.is_none() {
                        pending_mod_start = Some(cur_line);
                    }
                } else {
                    flush_del(&mut out, &mut run_del_at);
                    if run_add_start.is_none() {
                        run_add_start = Some(cur_line);
                    }
                }
                last_was_delete = false;
                cur_line += 1;
            }
        }
    }

    flush_add(&mut out, &mut run_add_start, cur_line);
    flush_mod(&mut out, &mut pending_mod_start, cur_line);
    flush_del(&mut out, &mut run_del_at);
    out
}
