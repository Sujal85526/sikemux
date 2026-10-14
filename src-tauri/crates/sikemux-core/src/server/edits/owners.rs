//! Which agent wrote each uncommitted line of a checkout: a file's recorded
//! edits replayed in order, each moving the lines the ones before it wrote,
//! then laid over what git reports as changed. Where something the record
//! does not know of changed a file, its lines are left without an owner.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use super::{line_count, read_text, Edit};
use crate::server::names::project_of;
use crate::server::Core;

const TIMEOUT: Duration = Duration::from_secs(60);
const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
/// What git diffs against before a repository's first commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Serialize, Default)]
pub(crate) struct Owners {
    pub authors: Vec<Author>,
    pub files: Vec<FileOwners>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Author {
    pub agent_id: String,
    pub name: String,
    pub cli: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The chat run of its latest edit.
    pub feed: String,
}

/// The changed lines of a file agents wrote, by its path in the checkout.
#[derive(Serialize)]
pub(crate) struct FileOwners {
    pub path: String,
    pub lines: Vec<Run>,
    pub removed: Vec<Removal>,
}

/// `count` lines from `start` that `author` wrote last. `over` is the agent
/// whose lines it rewrote there.
#[derive(Serialize)]
pub(crate) struct Run {
    pub start: u64,
    pub count: u64,
    pub author: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub over: Option<usize>,
}

/// Lines `author` took out just before line `at`.
#[derive(Serialize)]
pub(crate) struct Removal {
    pub at: u64,
    pub author: usize,
}

/// `count` lines from `start` in the newer file stand where `removed` stood,
/// as in the edit record.
#[derive(Clone, Copy)]
struct Hunk {
    start: u64,
    count: u64,
    removed: u64,
}

/// Who wrote each line `dir`'s checkout changed since its last commit, or,
/// when `staged`, each line it has staged, numbered as in the index.
pub(crate) fn owners(core: &Core, dir: &Path, staged: bool) -> Result<Owners, String> {
    let top = git(dir, &["rev-parse", "--show-toplevel"])?;
    let top = Path::new(top.trim());
    let base = if git(top, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok() {
        "HEAD"
    } else {
        EMPTY_TREE
    };
    let changed = hunks(&git(top, &diff_args(staged, Some(base)))?);
    let (unstaged, untracked) = if staged {
        (hunks(&git(top, &diff_args(false, None))?), HashSet::new())
    } else {
        let others = git(top, &["ls-files", "-z", "--others", "--exclude-standard"])?;
        let others = others.split('\0').filter(|path| !path.is_empty());
        (HashMap::new(), others.map(str::to_owned).collect())
    };
    let paths: HashMap<String, &str> = changed
        .keys()
        .chain(&untracked)
        .map(|path| (top.join(path).to_string_lossy().into_owned(), path.as_str()))
        .collect();
    if paths.is_empty() {
        return Ok(Owners::default());
    }
    let project = project_of(dir, &core.workspaces.project_paths());
    let wanted = paths.keys().cloned().collect();
    let edits = core.edits.touching(&project, &wanted);
    let mut agents = Agents::default();
    let mut by_path: HashMap<&str, Vec<(usize, &Edit)>> = HashMap::new();
    for edit in &edits {
        let author = agents.of(edit);
        by_path.entry(&edit.path).or_default().push((author, edit));
    }
    let mut files = Vec::new();
    for (abs, edits) in by_path {
        let mut replay = Replay::default();
        for (author, edit) in edits {
            replay.apply(edit, author);
        }
        if replay.total.is_some()
            && read_text(Path::new(abs)).as_deref().map(line_count) != replay.total
        {
            continue;
        }
        let path = paths[abs];
        let index = |line| {
            if staged {
                in_index(unstaged.get(path).map_or(&[][..], Vec::as_slice), line)
            } else {
                Some(line)
            }
        };
        let (lines, removed) = match changed.get(path) {
            Some(hunks) => replay.laid_over(hunks, index),
            None => (runs(replay.lines.iter().copied()), Vec::new()),
        };
        if !lines.is_empty() || !removed.is_empty() {
            let path = path.to_owned();
            files.push(FileOwners {
                path,
                lines,
                removed,
            });
        }
    }
    Ok(agents.owners(core, files))
}

/// One trailer line for each agent that wrote something staged in `dir`, or
/// for `fallback` when none did.
pub(crate) fn commit_trailers(core: &Core, dir: &Path, fallback: Option<&str>) -> Vec<String> {
    let owners = owners(core, dir, true).unwrap_or_default();
    let wrote: HashSet<usize> = owners
        .files
        .iter()
        .flat_map(|file| {
            let lines = file.lines.iter().map(|run| run.author);
            lines.chain(file.removed.iter().map(|removal| removal.author))
        })
        .collect();
    let mut authors: Vec<Author> = owners
        .authors
        .into_iter()
        .enumerate()
        .filter(|(at, _)| wrote.contains(at))
        .map(|(_, author)| author)
        .collect();
    if authors.is_empty() {
        let project = project_of(dir, &core.workspaces.project_paths());
        let latest = fallback.and_then(|id| {
            core.edits
                .matching(&project, |edit| edit.agent_id == id)
                .pop()
        });
        authors.extend(latest.map(|edit| author(core, &edit)));
    }
    authors
        .iter()
        .map(|author| {
            crate::trailers::agent(
                &author.name,
                &author.cli,
                author.model.as_deref(),
                &author.agent_id,
            )
        })
        .collect()
}

fn author(core: &Core, edit: &Edit) -> Author {
    Author {
        agent_id: edit.agent_id.clone(),
        name: core
            .names
            .name(&edit.agent_id)
            .or_else(|| edit.name.clone())
            .unwrap_or_else(|| edit.cli.clone()),
        cli: edit.cli.clone(),
        model: edit.model.clone(),
        feed: edit.feed.clone(),
    }
}

/// The agents met while replaying, each by its latest edit.
#[derive(Default)]
struct Agents<'a> {
    index: HashMap<&'a str, usize>,
    latest: Vec<&'a Edit>,
}

impl<'a> Agents<'a> {
    fn of(&mut self, edit: &'a Edit) -> usize {
        let at = *self
            .index
            .entry(&edit.agent_id)
            .or_insert(self.latest.len());
        if at == self.latest.len() {
            self.latest.push(edit);
        } else {
            self.latest[at] = edit;
        }
        at
    }

    /// `files` with their agents numbered again among only those they name.
    fn owners(self, core: &Core, mut files: Vec<FileOwners>) -> Owners {
        let mut numbers: Vec<Option<usize>> = vec![None; self.latest.len()];
        let mut authors = Vec::new();
        files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        let mut renumber = |agent: &mut usize| {
            *agent = *numbers[*agent].get_or_insert_with(|| {
                authors.push(author(core, self.latest[*agent]));
                authors.len() - 1
            });
        };
        for file in &mut files {
            for run in &mut file.lines {
                renumber(&mut run.author);
                if let Some(over) = &mut run.over {
                    renumber(over);
                }
            }
            for removal in &mut file.removed {
                renumber(&mut removal.author);
            }
        }
        Owners { authors, files }
    }
}

/// One part of an edit, starting at line `old` in the file before it.
/// `shift` is how far it and the parts above it move the lines below.
struct Block {
    old: u64,
    new: Hunk,
    shift: i64,
}

#[derive(Clone, Copy)]
struct Line {
    at: u64,
    author: usize,
    over: Option<usize>,
}

/// The lines agents wrote in one file as it stands after the edits so far.
#[derive(Default)]
struct Replay {
    lines: Vec<Line>,
    removed: Vec<(u64, usize)>,
    total: Option<u64>,
}

impl Replay {
    fn apply(&mut self, edit: &Edit, author: usize) {
        let grown: i64 = edit
            .lines
            .iter()
            .map(|[_, count, removed]| *count as i64 - *removed as i64)
            .sum();
        let follows = match (self.total, edit.total) {
            (Some(before), Some(after)) => before as i64 + grown == after as i64,
            _ => true,
        };
        self.total = edit.total;
        if edit.lines.is_empty() || !follows {
            self.lines.clear();
            self.removed.clear();
            if edit.lines.is_empty() {
                return;
            }
        }
        let mut sorted = edit.lines.clone();
        sorted.sort_unstable();
        let mut shift = 0i64;
        let blocks: Vec<Block> = sorted
            .into_iter()
            .map(|[start, count, removed]| {
                let old = (start as i64 - shift).max(1) as u64;
                shift += count as i64 - removed as i64;
                Block {
                    old,
                    new: Hunk {
                        start,
                        count,
                        removed,
                    },
                    shift,
                }
            })
            .collect();
        let mut over = vec![None; blocks.len()];
        let mut lines = Vec::with_capacity(self.lines.len());
        for line in self.lines.drain(..) {
            match place(&blocks, line.at) {
                Ok(at) => lines.push(Line { at, ..line }),
                Err(block) if line.author != author => over[block] = Some(line.author),
                Err(block) => over[block] = over[block].or(line.over),
            }
        }
        self.removed = self
            .removed
            .iter()
            .filter_map(|&(at, by)| place_gap(&blocks, at).map(|at| (at, by)))
            .collect();
        for (Block { new: hunk, .. }, over) in blocks.iter().zip(over) {
            if hunk.count == 0 && hunk.removed > 0 {
                self.removed.push((hunk.start, author));
            }
            lines.extend((hunk.start..hunk.start + hunk.count).map(|at| Line { at, author, over }));
        }
        lines.sort_unstable_by_key(|line| line.at);
        self.lines = lines;
    }

    /// The lines that are among `hunks`' new ones, numbered by `index`.
    fn laid_over(
        &self,
        hunks: &[Hunk],
        index: impl Fn(u64) -> Option<u64>,
    ) -> (Vec<Run>, Vec<Removal>) {
        let added = |line: u64| {
            let after = hunks.partition_point(|hunk| hunk.start <= line);
            after > 0 && line < hunks[after - 1].start + hunks[after - 1].count
        };
        let lines = self
            .lines
            .iter()
            .filter_map(|line| index(line.at).map(|at| Line { at, ..*line }))
            .filter(|line| added(line.at));
        let removed = self
            .removed
            .iter()
            .filter_map(|&(at, author)| index(at).map(|at| Removal { at, author }))
            .filter(|removal| {
                hunks
                    .iter()
                    .any(|hunk| hunk.count == 0 && hunk.start == removal.at)
            })
            .collect();
        (runs(lines), removed)
    }
}

/// Where `line` moves to through an edit's `blocks`, or the block that
/// replaced it.
fn place(blocks: &[Block], line: u64) -> Result<u64, usize> {
    let mut shift = 0;
    for (at, block) in blocks.iter().enumerate() {
        if line < block.old {
            break;
        }
        if line < block.old + block.new.removed {
            return Err(at);
        }
        shift = block.shift;
    }
    Ok((line as i64 + shift) as u64)
}

/// Where the gap just before `line` moves to, unless it was inside lines the
/// edit replaced.
fn place_gap(blocks: &[Block], line: u64) -> Option<u64> {
    let mut shift = 0;
    for block in blocks {
        if line <= block.old {
            break;
        }
        if line < block.old + block.new.removed {
            return None;
        }
        shift = block.shift;
    }
    Some((line as i64 + shift) as u64)
}

/// The index's number for a working tree line, given the working tree's
/// unstaged `hunks`, or none when the line is not staged.
fn in_index(hunks: &[Hunk], line: u64) -> Option<u64> {
    let mut shift = 0i64;
    for hunk in hunks {
        if line < hunk.start {
            break;
        }
        if line < hunk.start + hunk.count {
            return None;
        }
        shift += hunk.removed as i64 - hunk.count as i64;
    }
    Some((line as i64 + shift) as u64)
}

fn runs(lines: impl IntoIterator<Item = Line>) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for line in lines {
        match runs.last_mut() {
            Some(run)
                if run.start + run.count == line.at
                    && run.author == line.author
                    && run.over == line.over =>
            {
                run.count += 1;
            }
            _ => runs.push(Run {
                start: line.at,
                count: 1,
                author: line.author,
                over: line.over,
            }),
        }
    }
    runs
}

fn diff_args(staged: bool, base: Option<&str>) -> Vec<&str> {
    let mut args = vec![
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-U0",
    ];
    if staged {
        args.push("--cached");
    }
    args.extend(base);
    args
}

/// Each file's hunks in a `-U0` diff, by path.
fn hunks(diff: &str) -> HashMap<String, Vec<Hunk>> {
    let mut files: HashMap<String, Vec<Hunk>> = HashMap::new();
    let mut path: Option<String> = None;
    let mut left = 0u64;
    for line in diff.lines() {
        if left > 0 {
            if line.starts_with(['+', '-']) {
                left -= 1;
            }
            continue;
        }
        if let Some(target) = line.strip_prefix("+++ ") {
            path = target.strip_prefix("b/").map(str::to_owned);
        } else if let Some(hunk) = line.strip_prefix("@@ -").and_then(header) {
            left = hunk.count + hunk.removed;
            if let Some(path) = &path {
                files.entry(path.clone()).or_default().push(hunk);
            }
        }
    }
    files
}

/// A hunk from its header after `@@ -`: `a,b +c,d @@`.
fn header(text: &str) -> Option<Hunk> {
    let (old, rest) = text.split_once(" +")?;
    let new = rest.split_once(" @@")?.0;
    let range = |range: &str| -> Option<(u64, u64)> {
        match range.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((range.parse().ok()?, 1)),
        }
    };
    let (_, removed) = range(old)?;
    let (start, count) = range(new)?;
    Some(Hunk {
        start: if count == 0 { start + 1 } else { start },
        count,
        removed,
    })
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = sikemux_process::user_environment::command("git");
    command
        .args(["-c", "core.fsmonitor=false", "-c", "core.quotePath=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = sikemux_process::run(&mut command, None, TIMEOUT, OUTPUT_LIMIT, None)
        .map_err(|error| format!("git did not run: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
