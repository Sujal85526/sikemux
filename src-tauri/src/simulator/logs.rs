//! A simulator's log, kept from the moment an agent attaches it so `sim_logs`
//! can read what an app printed while the agent drove it.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{json, Value};

/// The latest lines of everything the device logs, Apple's frameworks left out.
const KEPT_LINES: usize = 5_000;
/// The latest lines of each process, kept apart so one chatty process does not push out another's.
const KEPT_PER_PROCESS: usize = 500;
const DEFAULT_LIMIT: usize = 200;

/// Lines numbered from the first, keeping only the latest `capacity`.
pub(super) struct Ring {
    capacity: usize,
    first: u64,
    lines: VecDeque<String>,
}

impl Ring {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            first: 0,
            lines: VecDeque::new(),
        }
    }

    fn push(&mut self, line: String) {
        if self.lines.len() == self.capacity {
            self.lines.pop_front();
            self.first += 1;
        }
        self.lines.push_back(line);
    }

    /// At most `limit` lines from `cursor` on, with the cursor to read on from.
    /// Lines dropped before the read are counted, so a reader knows it fell behind.
    fn read(&self, cursor: u64, limit: usize) -> Value {
        let end = self.first + self.lines.len() as u64;
        let start = cursor.clamp(self.first, end);
        let lines: Vec<&str> = self
            .lines
            .iter()
            .skip((start - self.first) as usize)
            .take(limit)
            .map(String::as_str)
            .collect();
        let next = start + lines.len() as u64;
        let mut answer = json!({ "lines": lines, "cursor": next, "more": next < end });
        if cursor < self.first {
            answer["dropped"] = (self.first - cursor).into();
        }
        answer
    }
}

/// Everything a device logged, and each process's own lines.
pub(super) struct Lines {
    all: Ring,
    by_process: HashMap<String, Ring>,
}

impl Default for Lines {
    fn default() -> Self {
        Self {
            all: Ring::new(KEPT_LINES),
            by_process: HashMap::new(),
        }
    }
}

impl Lines {
    pub(super) fn push(&mut self, line: String) {
        if let Some(process) = process_of(&line) {
            self.by_process
                .entry(process.to_owned())
                .or_insert_with(|| Ring::new(KEPT_PER_PROCESS))
                .push(line.clone());
        }
        self.all.push(line);
    }

    /// Reads everything, or one process's own lines, whose cursor counts only its lines.
    pub(super) fn read(&self, cursor: u64, process: Option<&str>, limit: usize) -> Value {
        match process {
            None => self.all.read(cursor, limit),
            Some(process) => match self.by_process.get(process) {
                Some(ring) => ring.read(cursor, limit),
                None => json!({ "lines": [], "cursor": 0, "more": false }),
            },
        }
    }
}

/// A compact log line names its process before the bracket holding its id:
/// `2026-10-03 14:00:00.123 Df Maps[1234:5678] message`.
fn process_of(line: &str) -> Option<&str> {
    line.split_whitespace()
        .find_map(|word| word.split_once('['))
        .map(|(name, _)| name)
        .filter(|name| !name.is_empty())
}

struct Stream {
    child: Child,
    lines: Arc<Mutex<Lines>>,
}

#[derive(Default)]
pub(super) struct Logs {
    streams: Mutex<HashMap<String, Stream>>,
}

impl Logs {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Stream>> {
        self.streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts keeping `udid`'s log, once; a stream that has ended starts again.
    pub(super) fn follow(&self, udid: &str) -> Result<(), String> {
        let mut streams = self.lock();
        if let Some(stream) = streams.get_mut(udid) {
            if matches!(stream.child.try_wait(), Ok(None)) {
                return Ok(());
            }
        }
        let mut child = sikemux_process::user_environment::command("xcrun")
            .args([
                "simctl", "spawn", udid, "log", "stream", "--style", "compact", "--level", "info",
            ])
            // Apple's own frameworks log thousands of lines a second, among them every
            // accessibility read an agent makes; an app's own logging is what remains.
            .args(["--predicate", "NOT (subsystem BEGINSWITH \"com.apple.\")"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("could not read the simulator's log: {error}"))?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let lines: Arc<Mutex<Lines>> = Arc::default();
        let kept = Arc::clone(&lines);
        std::thread::Builder::new()
            .name("sikemux-sim-log".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    kept.lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push(line);
                }
            })
            .map_err(|error| format!("could not read the simulator's log: {error}"))?;
        streams.insert(udid.to_owned(), Stream { child, lines });
        Ok(())
    }

    pub(super) fn read(
        &self,
        udid: &str,
        cursor: u64,
        process: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Value, String> {
        self.follow(udid)?;
        let lines = Arc::clone(&self.lock().get(udid).expect("followed above").lines);
        let read = lines
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .read(cursor, process, limit.unwrap_or(DEFAULT_LIMIT));
        Ok(read)
    }

    pub(super) fn stop(&self, udid: &str) {
        if let Some(mut stream) = self.lock().remove(udid) {
            let _ = stream.child.kill();
            let _ = stream.child.wait();
        }
    }

    pub(super) fn stop_all(&self) {
        for (_, mut stream) in self.lock().drain() {
            let _ = stream.child.kill();
            let _ = stream.child.wait();
        }
    }
}
