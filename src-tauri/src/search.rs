// Project-scoped global search backing the Cmd+Shift+F panel.
//
// Built on `grep-searcher` (the same engine ripgrep uses). Walks the repo
// with the file palette's denylist so we don't search through node_modules,
// build outputs, vendored deps, etc. Binary files are skipped automatically
// (`BinaryDetection::quit`).
//
// The command is synchronous + capped — at typical project sizes ripgrep
// finishes in tens of ms, which is well inside what a debounced query input
// needs. If a search hits the caps the response sets `truncated: true` so
// the UI can show a "results truncated" hint.

use globset::{Glob, GlobMatcher};
use grep_matcher::{Match, Matcher};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, Searcher, Sink, SinkMatch};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

use crate::files;

// ---- caps ---------------------------------------------------------------

const MAX_FILES: usize = 1000;
const MAX_PER_FILE: usize = 200;
const MAX_TOTAL_MATCHES: usize = 5000;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

// ---- wire types --------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    whole_word: bool,
    #[serde(default)]
    is_regex: bool,
    /// Glob pattern restricting which paths participate (empty = all).
    #[serde(default)]
    include: String,
    /// Glob pattern excluding paths (in addition to the built-in denylist).
    #[serde(default)]
    exclude: String,
}

#[derive(Serialize, Clone)]
pub struct SearchRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Serialize)]
pub struct SearchHit {
    pub line: u32,
    pub text: String,
    pub ranges: Vec<SearchRange>,
}

#[derive(Serialize)]
pub struct SearchFile {
    pub path: String,
    pub matches: Vec<SearchHit>,
}

#[derive(Serialize)]
pub struct SearchResults {
    pub files: Vec<SearchFile>,
    pub file_count: usize,
    pub match_count: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

// ---- per-file sink -----------------------------------------------------

struct FileSink<'a, M: Matcher> {
    matches: &'a mut Vec<SearchHit>,
    matcher: &'a M,
    limit: usize,
    hit_limit: &'a mut bool,
}

impl<'a, M: Matcher> Sink for FileSink<'a, M> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, std::io::Error> {
        if self.matches.len() >= self.limit {
            *self.hit_limit = true;
            return Ok(false);
        }
        let line = mat.line_number().unwrap_or(0) as u32;
        let raw = mat.bytes();
        // Strip trailing CR/LF — match-line bytes include the terminator.
        let trimmed = strip_eol(raw);
        let text = String::from_utf8_lossy(trimmed).to_string();

        // Re-scan the line text to recover every match span (the searcher
        // only tells us the line, not the in-line positions).
        let mut ranges: Vec<SearchRange> = Vec::new();
        let _ = self.matcher.find_iter(trimmed, |m: Match| {
            ranges.push(SearchRange {
                start: m.start() as u32,
                end: m.end() as u32,
            });
            true
        });

        self.matches.push(SearchHit { line, text, ranges });
        Ok(true)
    }
}

fn strip_eol(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    if end > 0 && bytes[end - 1] == b'\n' {
        end -= 1;
        if end > 0 && bytes[end - 1] == b'\r' {
            end -= 1;
        }
    }
    &bytes[..end]
}

// ---- matcher construction ---------------------------------------------

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(
            c,
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' |
            '{' | '}' | '^' | '$' | '#' | '&' | '-' | '~'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn build_matcher(query: &str, opts: &SearchOptions) -> Result<grep_regex::RegexMatcher, String> {
    let raw = if opts.is_regex {
        query.to_string()
    } else {
        regex_escape(query)
    };
    let pattern = if opts.whole_word {
        format!(r"\b{}\b", raw)
    } else {
        raw
    };
    RegexMatcherBuilder::new()
        .case_insensitive(!opts.case_sensitive)
        .build(&pattern)
        .map_err(|e| format!("{e}"))
}

fn build_glob(pat: &str) -> Result<Option<GlobMatcher>, String> {
    let trimmed = pat.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Glob::new(trimmed)
        .map(|g| Some(g.compile_matcher()))
        .map_err(|e| format!("{e}"))
}

// ---- command ----------------------------------------------------------

#[tauri::command]
pub async fn project_search(
    repo: String,
    query: String,
    options: SearchOptions,
) -> Result<SearchResults, String> {
    let started = std::time::Instant::now();

    if query.is_empty() {
        return Ok(SearchResults {
            files: vec![],
            file_count: 0,
            match_count: 0,
            truncated: false,
            elapsed_ms: 0,
        });
    }

    let matcher = build_matcher(&query, &options)?;
    let include = build_glob(&options.include)?;
    let exclude = build_glob(&options.exclude)?;

    let walker = WalkBuilder::new(&repo)
        .hidden(false)
        .git_ignore(false)
        .git_exclude(false)
        .git_global(false)
        .ignore(false)
        .parents(false)
        .follow_links(false)
        .filter_entry(|entry| {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !files::should_skip_dir(&name)
        })
        .build();

    let mut out: Vec<SearchFile> = Vec::new();
    let mut total: usize = 0;
    let mut truncated = false;
    let root_len = repo.len() + 1;

    let mut searcher = Searcher::new();
    searcher.set_binary_detection(BinaryDetection::quit(b'\x00'));

    for entry in walker.flatten() {
        if total >= MAX_TOTAL_MATCHES || out.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        let ft = match entry.file_type() {
            Some(t) => t,
            None => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let path = entry.path();
        let path_str = path.to_string_lossy();
        if path_str.len() <= root_len {
            continue;
        }
        let rel = path_str[root_len..].to_string();

        if let Some(ref inc) = include {
            if !inc.is_match(&rel) {
                continue;
            }
        }
        if let Some(ref exc) = exclude {
            if exc.is_match(&rel) {
                continue;
            }
        }
        // Skip absurdly large files; rarely interesting to search and
        // dominates the wall-clock budget.
        if let Ok(meta) = entry.metadata() {
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
        }

        let mut matches: Vec<SearchHit> = Vec::new();
        let mut hit_limit = false;
        let mut sink = FileSink {
            matches: &mut matches,
            matcher: &matcher,
            limit: MAX_PER_FILE,
            hit_limit: &mut hit_limit,
        };
        let _ = searcher.search_path(&matcher, path, &mut sink);
        if hit_limit {
            truncated = true;
        }
        if !matches.is_empty() {
            total += matches.len();
            out.push(SearchFile { path: rel, matches });
        }
    }

    let file_count = out.len();
    Ok(SearchResults {
        files: out,
        file_count,
        match_count: total,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
