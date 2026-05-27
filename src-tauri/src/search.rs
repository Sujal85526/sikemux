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
use regex::bytes::RegexBuilder as BytesRegexBuilder;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::error::{AppError, AppResult};
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

#[derive(Serialize)]
pub struct ReplaceFile {
    pub path: String,
    pub match_count: usize,
}

#[derive(Serialize)]
pub struct ReplaceError {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct ReplaceResults {
    pub files: Vec<ReplaceFile>,
    pub file_count: usize,
    pub match_count: usize,
    pub errors: Vec<ReplaceError>,
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

fn build_matcher(query: &str, opts: &SearchOptions) -> AppResult<grep_regex::RegexMatcher> {
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
        .map_err(|e| AppError::Search(e.to_string()))
}

fn build_glob(pat: &str) -> AppResult<Option<GlobMatcher>> {
    let trimmed = pat.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Glob::new(trimmed)
        .map(|g| Some(g.compile_matcher()))
        .map_err(|e| AppError::Search(e.to_string()))
}

// ---- command ----------------------------------------------------------

#[tauri::command]
pub async fn project_search(
    repo: String,
    query: String,
    options: SearchOptions,
) -> AppResult<SearchResults> {
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

// ---- replace ----------------------------------------------------------
//
// Mirrors `project_search`'s walker + glob filtering so the set of files
// considered is identical. For each candidate we build a `regex::bytes`
// matcher with the same flags, run `replace_all` over the file bytes, and
// only rewrite the file when the content actually changed.
//
// Replacements run literally for plain queries; in regex mode `$1` / `${name}`
// backreferences work as `regex`'s standard replacement syntax. Errors per
// file (read/write/utf8) are collected into `errors[]` rather than aborting
// — partial completion is usually what you want here.

fn build_bytes_regex(query: &str, opts: &SearchOptions) -> AppResult<regex::bytes::Regex> {
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
    BytesRegexBuilder::new(&pattern)
        .case_insensitive(!opts.case_sensitive)
        .multi_line(true)
        .build()
        .map_err(|e| AppError::Search(e.to_string()))
}

#[tauri::command]
pub async fn project_search_replace(
    repo: String,
    query: String,
    replace: String,
    options: SearchOptions,
) -> AppResult<ReplaceResults> {
    let started = std::time::Instant::now();

    if query.is_empty() {
        return Ok(ReplaceResults {
            files: vec![],
            file_count: 0,
            match_count: 0,
            errors: vec![],
            elapsed_ms: 0,
        });
    }

    // Two matchers: grep-regex for counting hits via the searcher (so the
    // pre-flight count matches `project_search` exactly), and regex::bytes
    // for the actual in-memory rewrite.
    let count_matcher = build_matcher(&query, &options)?;
    let rewrite_re = build_bytes_regex(&query, &options)?;
    let include = build_glob(&options.include)?;
    let exclude = build_glob(&options.exclude)?;
    let replacement_bytes = replace.as_bytes().to_vec();

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

    let mut changed: Vec<ReplaceFile> = Vec::new();
    let mut errors: Vec<ReplaceError> = Vec::new();
    let mut total_matches: usize = 0;
    let root_len = repo.len() + 1;

    let mut searcher = Searcher::new();
    searcher.set_binary_detection(BinaryDetection::quit(b'\x00'));

    for entry in walker.flatten() {
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
        if let Ok(meta) = entry.metadata() {
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
        }

        // Cheap pre-flight: skip files with no matches at all so we don't
        // pay the read+rewrite cost on irrelevant files. We use the same
        // sink as project_search but only need to know if anything matched.
        let mut bail = false;
        let mut sink_matches: Vec<SearchHit> = Vec::new();
        {
            let mut sink = FileSink {
                matches: &mut sink_matches,
                matcher: &count_matcher,
                limit: MAX_PER_FILE,
                hit_limit: &mut bail,
            };
            let _ = searcher.search_path(&count_matcher, path, &mut sink);
        }
        let count = sink_matches.len();
        if count == 0 {
            continue;
        }

        // Read, rewrite, write-back. If the file isn't valid UTF-8 we skip
        // it — replace on arbitrary binary data is a footgun and the
        // searcher already filters binaries earlier, but the byte-regex
        // doesn't care so we double-check here.
        let original = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) => {
                errors.push(ReplaceError {
                    path: rel.clone(),
                    reason: format!("read failed: {e}"),
                });
                continue;
            }
        };
        if std::str::from_utf8(&original).is_err() {
            errors.push(ReplaceError {
                path: rel.clone(),
                reason: "skipped: file is not valid UTF-8".to_string(),
            });
            continue;
        }

        let rewritten =
            rewrite_re.replace_all(&original, replacement_bytes.as_slice()).into_owned();
        if rewritten == original {
            continue;
        }

        let tmp = sibling_tmp(path);
        if let Err(e) = fs::write(&tmp, &rewritten) {
            errors.push(ReplaceError {
                path: rel.clone(),
                reason: format!("write failed: {e}"),
            });
            continue;
        }
        // Atomic-ish: rename onto the original path. On the same filesystem
        // this swaps in one syscall so editors / file watchers see exactly
        // one change rather than a half-written intermediate.
        if let Err(e) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            errors.push(ReplaceError {
                path: rel.clone(),
                reason: format!("rename failed: {e}"),
            });
            continue;
        }

        total_matches += count;
        changed.push(ReplaceFile { path: rel, match_count: count });
    }

    let file_count = changed.len();
    Ok(ReplaceResults {
        files: changed,
        file_count,
        match_count: total_matches,
        errors,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn sibling_tmp(path: &std::path::Path) -> PathBuf {
    let mut name = path.file_name().map(|s| s.to_os_string()).unwrap_or_default();
    name.push(".sikemux.replace.tmp");
    path.with_file_name(name)
}
