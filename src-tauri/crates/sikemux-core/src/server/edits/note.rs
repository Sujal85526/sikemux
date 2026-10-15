//! Which lines of a commit each agent wrote, for a commit no one writer has
//! all the lines of: a git note on it under [`NOTES_REF`], put there by the
//! hooks that sign its footer. Lines are numbered as the commit has its files,
//! as `git blame` names them. A note counts only for the agents the commit's
//! verified footer names, since anyone can write one.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use super::owners::{run, Diff, Owners};
use crate::trailers::{Agent, NOTES_REF};

/// Runs of lines, first and last, by path.
pub(crate) type Wrote = BTreeMap<String, Vec<[u64; 2]>>;

/// What each agent wrote, by its chat.
pub(crate) type Note = BTreeMap<String, Wrote>;

/// The note for a commit of what `diff` says was staged, when its lines are
/// not all one agent's: the person's commit holding some lines no agent wrote,
/// or any commit holding lines of several. It names only `agents`, those the
/// commit's footer names.
pub(super) fn of(
    owners: &Owners,
    diff: &Diff,
    agents: &[Agent],
    by_person: bool,
) -> Option<String> {
    let named: HashSet<&str> = agents.iter().map(|agent| agent.chat.as_str()).collect();
    let mut note = Note::new();
    let mut owned = 0;
    for file in owners
        .files
        .iter()
        .filter(|file| diff.changed.contains_key(&file.path))
    {
        for run in &file.lines {
            let last = run.start + run.count - 1;
            let mut counted = false;
            for chat in owners.authors[run.author].agents() {
                if !named.contains(chat) {
                    continue;
                }
                counted = true;
                let runs = note
                    .entry(chat.to_owned())
                    .or_default()
                    .entry(file.path.clone())
                    .or_default();
                match runs.last_mut() {
                    Some([_, end]) if *end + 1 == run.start => *end = last,
                    _ => runs.push([run.start, last]),
                }
            }
            if counted {
                owned += run.count;
            }
        }
    }
    let added: u64 = diff.changed.values().flatten().map(|hunk| hunk.count).sum();
    let one_writer = note.len() == 1 && (!by_person || owned >= added);
    if note.is_empty() || one_writer {
        return None;
    }
    serde_json::to_string(&note).ok()
}

/// The notes on `commits`, full hashes, by commit, from one run of git.
pub(crate) fn read(dir: &Path, commits: &[&str]) -> HashMap<String, Note> {
    let commits: Vec<&str> = commits
        .iter()
        .copied()
        .filter(|commit| matches!(commit.len(), 40 | 64))
        .collect();
    if commits.is_empty() {
        return HashMap::new();
    }
    // Git spreads a big notes tree over folders named for each hash's first
    // characters, so each commit is asked for at every depth.
    let mut asked = Vec::new();
    let mut input = String::new();
    for commit in &commits {
        for depth in 0..=2 {
            let (folders, rest) = commit.split_at(depth * 2);
            let folders: Vec<&str> = (0..depth).map(|at| &folders[at * 2..at * 2 + 2]).collect();
            let path = folders
                .into_iter()
                .chain([rest])
                .collect::<Vec<_>>()
                .join("/");
            input.push_str(&format!("{NOTES_REF}:{path}\n"));
            asked.push(*commit);
        }
    }
    let Ok(out) = run(dir, &["cat-file", "--batch"], None, Some(input.as_bytes())) else {
        return HashMap::new();
    };
    let mut notes = HashMap::new();
    let mut rest = out.as_slice();
    for commit in asked {
        let Some(end) = rest.iter().position(|byte| *byte == b'\n') else {
            break;
        };
        let header = String::from_utf8_lossy(&rest[..end]).into_owned();
        rest = &rest[end + 1..];
        let mut words = header.split(' ');
        let (Some(_), Some(kind), Some(size)) = (words.next(), words.next(), words.next()) else {
            continue;
        };
        let Ok(size) = size.parse::<usize>() else {
            continue;
        };
        let Some(content) = rest.get(..size) else {
            break;
        };
        rest = rest.get(size + 1..).unwrap_or_default();
        if kind != "blob" {
            continue;
        }
        if let Ok(mut note) = serde_json::from_slice::<Note>(content) {
            note.values_mut()
                .flat_map(BTreeMap::values_mut)
                .for_each(|runs| runs.sort_unstable());
            notes.insert(commit.to_owned(), note);
        }
    }
    notes
}

/// Whether `line` of `path` is among `wrote`'s.
pub(crate) fn holds(wrote: &Wrote, path: &str, line: u64) -> bool {
    wrote.get(path).is_some_and(|runs| {
        let after = runs.partition_point(|[first, _]| *first <= line);
        after > 0 && line <= runs[after - 1][1]
    })
}
