use std::fmt;
use std::io::{self, Read, Write};
use std::process::{Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum ProcessRunError {
    Spawn(io::Error),
    Io(io::Error),
    Timeout(Duration),
    OutputLimit(usize),
    Cancelled,
    WorkerPanic(&'static str),
    MissingPipe(&'static str),
}

impl fmt::Display for ProcessRunError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) | Self::Io(error) => error.fmt(formatter),
            Self::Timeout(timeout) => write!(
                formatter,
                "subprocess timed out after {}s",
                timeout.as_secs()
            ),
            Self::OutputLimit(limit) => write!(
                formatter,
                "subprocess output exceeds {} MiB limit",
                limit / 1024 / 1024
            ),
            Self::Cancelled => formatter.write_str("subprocess was cancelled"),
            Self::WorkerPanic(worker) => write!(formatter, "{worker} worker panicked"),
            Self::MissingPipe(pipe) => write!(formatter, "subprocess {pipe} unavailable"),
        }
    }
}

impl std::error::Error for ProcessRunError {}

#[derive(Clone)]
pub struct ProcessCancellation(Arc<AtomicBool>);

impl ProcessCancellation {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

fn kill_and_reap(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn read_bounded(
    mut pipe: impl Read,
    total: Arc<AtomicUsize>,
    exceeded: Arc<AtomicBool>,
    max_output_bytes: usize,
) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        let read = pipe.read(&mut chunk)?;
        if read == 0 {
            return Ok(bytes);
        }
        let previous = total.fetch_add(read, Ordering::AcqRel);
        if previous.saturating_add(read) > max_output_bytes {
            exceeded.store(true, Ordering::Release);
            return Err(io::Error::other("subprocess output limit exceeded"));
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
}

/// Run a child with concurrent pipe drainage, a combined output ceiling,
/// process-group ownership, a hard deadline, and optional cooperative cancel.
pub fn run(
    command: &mut Command,
    input: Option<&[u8]>,
    timeout: Duration,
    max_output_bytes: usize,
    cancellation: Option<&ProcessCancellation>,
) -> Result<Output, ProcessRunError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(ProcessRunError::Spawn)?;
    let stdout = child.stdout.take().ok_or_else(|| {
        kill_and_reap(&mut child);
        ProcessRunError::MissingPipe("stdout")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        kill_and_reap(&mut child);
        ProcessRunError::MissingPipe("stderr")
    })?;

    let total = Arc::new(AtomicUsize::new(0));
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout_reader = {
        let total = Arc::clone(&total);
        let exceeded = Arc::clone(&exceeded);
        std::thread::spawn(move || read_bounded(stdout, total, exceeded, max_output_bytes))
    };
    let stderr_reader = {
        let total = Arc::clone(&total);
        let exceeded = Arc::clone(&exceeded);
        std::thread::spawn(move || read_bounded(stderr, total, exceeded, max_output_bytes))
    };
    let stdin_writer = input.map(|bytes| {
        let bytes = bytes.to_vec();
        let stdin = child.stdin.take();
        std::thread::spawn(move || {
            let mut stdin = stdin.ok_or(ProcessRunError::MissingPipe("stdin"))?;
            stdin.write_all(&bytes).map_err(ProcessRunError::Io)
        })
    });

    let deadline = Instant::now() + timeout;
    let mut completed_status = None;
    let status = loop {
        if cancellation.is_some_and(ProcessCancellation::is_cancelled) {
            kill_and_reap(&mut child);
            break Err(ProcessRunError::Cancelled);
        }
        if exceeded.load(Ordering::Acquire) {
            kill_and_reap(&mut child);
            break Err(ProcessRunError::OutputLimit(max_output_bytes));
        }
        if completed_status.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => completed_status = Some(status),
                Ok(None) => {}
                Err(error) => {
                    kill_and_reap(&mut child);
                    break Err(ProcessRunError::Io(error));
                }
            }
        }
        if let Some(status) = completed_status {
            if stdout_reader.is_finished() && stderr_reader.is_finished() {
                break Ok(status);
            }
        }
        if Instant::now() >= deadline {
            // The direct child may already have exited while a descendant
            // retains one of its pipes. The process-group kill closes those
            // handles so reader joins remain bounded as well.
            kill_and_reap(&mut child);
            break Err(ProcessRunError::Timeout(timeout));
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    let stdin_result = if let Some(writer) = stdin_writer {
        Some(
            writer
                .join()
                .map_err(|_| ProcessRunError::WorkerPanic("stdin"))?,
        )
    } else {
        None
    };
    let stdout_result = stdout_reader
        .join()
        .map_err(|_| ProcessRunError::WorkerPanic("stdout"))?
        .map_err(ProcessRunError::Io);
    let stderr_result = stderr_reader
        .join()
        .map_err(|_| ProcessRunError::WorkerPanic("stderr"))?
        .map_err(ProcessRunError::Io);
    // Process-level policy errors are more useful than the expected broken
    // pipe errors caused by enforcing them.
    let status = status?;
    if let Some(result) = stdin_result {
        result?;
    }
    let stdout = stdout_result?;
    let stderr = stderr_result?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}
