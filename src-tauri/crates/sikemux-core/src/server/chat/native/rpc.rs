//! JSON-RPC over an agent's standard input and output: requests this side
//! sends and waits on, and the agent's own requests and notifications.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::process::Writer;

/// How long a request may wait for its answer before the agent is taken to
/// be stuck.
pub(crate) const ANSWER_WAIT: Duration = Duration::from_secs(120);

/// The code JSON-RPC gives an error inside the side that reports it.
const INTERNAL_ERROR: i64 = -32603;

/// An answer, or the error object the agent turned the request down with.
type Answer = oneshot::Sender<Result<Value, Value>>;

/// One message the agent sent that is not an answer to this side.
pub(crate) enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

/// An error object for a request that got no answer from the agent.
fn unanswered(message: impl Into<String>) -> Value {
    json!({ "code": INTERNAL_ERROR, "message": message.into() })
}

/// What an error object says, in words.
pub(crate) fn error_text(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map_or_else(|| error.to_string(), str::to_owned)
}

#[derive(Clone)]
pub(crate) struct Rpc {
    writer: Writer,
    next_id: Arc<AtomicI64>,
    waiting: Arc<Mutex<HashMap<i64, Answer>>>,
    /// Whether every message names its JSON-RPC version. Codex leaves it out;
    /// Muse refuses a message without it.
    versioned: bool,
}

/// A request that has been sent, and the answer still to come.
pub(crate) struct Sent {
    rpc: Rpc,
    id: i64,
    method: String,
    answered: oneshot::Receiver<Result<Value, Value>>,
}

impl Sent {
    /// The agent's answer, or its error object. With a `wait`, a request left
    /// unanswered that long fails.
    pub async fn answer(self, wait: Option<Duration>) -> Result<Value, Value> {
        let answered = match wait {
            Some(wait) => match tokio::time::timeout(wait, self.answered).await {
                Ok(answered) => answered,
                Err(_) => {
                    self.rpc.forget(self.id);
                    return Err(unanswered(format!(
                        "The agent did not answer {}",
                        self.method
                    )));
                }
            },
            None => self.answered.await,
        };
        answered.unwrap_or_else(|_| Err(unanswered("The agent stopped before it answered")))
    }
}

impl Rpc {
    pub fn new(writer: Writer) -> Self {
        Self {
            writer,
            next_id: Arc::new(AtomicI64::new(1)),
            waiting: Arc::new(Mutex::new(HashMap::new())),
            versioned: false,
        }
    }

    pub fn versioned(writer: Writer) -> Self {
        Self {
            versioned: true,
            ..Self::new(writer)
        }
    }

    fn send(&self, mut message: Value) -> Result<(), String> {
        if self.versioned {
            message["jsonrpc"] = json!("2.0");
        }
        self.writer.send(&message)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.start(method, params)
            .map_err(|error| error_text(&error))?
            .answer(Some(ANSWER_WAIT))
            .await
            .map_err(|error| error_text(&error))
    }

    /// Sends a request without waiting on its answer.
    pub fn start(&self, method: &str, params: Value) -> Result<Sent, Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        self.waiting().insert(id, answer);
        if let Err(error) = self.send(json!({ "id": id, "method": method, "params": params })) {
            self.forget(id);
            return Err(unanswered(error));
        }
        Ok(Sent {
            rpc: self.clone(),
            id,
            method: method.to_owned(),
            answered,
        })
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let mut message = json!({ "method": method });
        if !(self.versioned && params.is_null()) {
            message["params"] = params;
        }
        self.send(message)
    }

    pub fn respond(&self, id: Value, result: Value) {
        let _ = self.send(json!({ "id": id, "result": result }));
    }

    pub fn refuse(&self, id: Value, message: &str) {
        let _ = self.send(json!({
            "id": id,
            "error": { "code": -32601, "message": message },
        }));
    }

    fn waiting(&self) -> std::sync::MutexGuard<'_, HashMap<i64, Answer>> {
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn forget(&self, id: i64) {
        self.waiting().remove(&id);
    }

    /// Hands an answer to the request waiting on it, or reads the message as
    /// one of the agent's own.
    pub fn read(&self, message: Value) -> Option<Incoming> {
        let Value::Object(mut message) = message else {
            return None;
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let params = message.remove("params").unwrap_or(Value::Null);
        match (message.remove("id"), method) {
            (Some(id), Some(method)) => Some(Incoming::Request { id, method, params }),
            (None, Some(method)) => Some(Incoming::Notification { method, params }),
            (Some(id), None) => {
                let answer = id.as_i64().and_then(|id| self.waiting().remove(&id));
                if let Some(answer) = answer {
                    let result = match message.remove("error") {
                        Some(error) => Err(error),
                        None => Ok(message.remove("result").unwrap_or(Value::Null)),
                    };
                    let _ = answer.send(result);
                }
                None
            }
            (None, None) => None,
        }
    }

    /// Fails every request still waiting, once the agent is gone.
    pub fn close(&self) {
        for (_, answer) in self.waiting().drain() {
            let _ = answer.send(Err(unanswered("The agent stopped before it answered")));
        }
    }
}
