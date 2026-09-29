// Bitbucket's rate limit. It counts requests over a rolling hour and says
// nothing about it until a request is refused, so once one is, requests are
// held back here for a while, longer each time it happens again.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderMap;
use reqwest::StatusCode;
use serde::Serialize;

use crate::error::{BitbucketError, BitbucketResult};

const FIRST_WAIT_SECS: u64 = 60;
const LONGEST_WAIT_SECS: u64 = 15 * 60;
/// A wait this short is sat out and the read tried again, rather than failing it.
pub const SHORT_WAIT_SECS: u64 = 3;

#[derive(Serialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// Whether requests are being held back until `resets_at`.
    pub limited: bool,
    /// Seconds since the epoch.
    pub resets_at: Option<u64>,
    pub remaining: Option<u64>,
    pub limit: Option<u64>,
    /// Bitbucket says fewer than a fifth of the hour's requests are left.
    pub near: bool,
}

#[derive(Clone, Copy)]
struct State {
    budget: Budget,
    /// Refusals in a row, which lengthen the wait.
    strikes: u32,
}

static STATE: Mutex<State> = Mutex::new(State {
    budget: Budget {
        limited: false,
        resets_at: None,
        remaining: None,
        limit: None,
        near: false,
    },
    strikes: 0,
});

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

fn number(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

/// How long a refusal says to wait, or how long to wait after this many refusals in a row.
fn wait_after(headers: &HeaderMap, strikes: u32) -> u64 {
    number(headers, "retry-after").unwrap_or_else(|| {
        FIRST_WAIT_SECS
            .saturating_mul(1 << strikes.saturating_sub(1).min(6))
            .min(LONGEST_WAIT_SECS)
    })
}

/// The wait a 429 names, for deciding whether to sit it out; `None` for any other answer.
pub fn named_wait(status: StatusCode, headers: &HeaderMap) -> Option<u64> {
    (status == StatusCode::TOO_MANY_REQUESTS)
        .then(|| number(headers, "retry-after"))
        .flatten()
}

pub fn check() -> BitbucketResult<()> {
    let now = now_secs();
    let mut state = STATE
        .lock()
        .map_err(|_| BitbucketError::Transport("rate limit state".into()))?;
    match state.budget.resets_at {
        Some(at) if state.budget.limited && at > now => Err(BitbucketError::RateLimited {
            resets_in_secs: at - now,
        }),
        _ => {
            state.budget.limited = false;
            Ok(())
        }
    }
}

pub fn observe(status: StatusCode, headers: &HeaderMap) {
    let Ok(mut state) = STATE.lock() else {
        return;
    };
    if let Some(limit) = number(headers, "x-ratelimit-limit") {
        state.budget.limit = Some(limit);
    }
    if let Some(near) = headers
        .get("x-ratelimit-nearlimit")
        .and_then(|value| value.to_str().ok())
    {
        state.budget.near = near.trim().eq_ignore_ascii_case("true");
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        state.strikes = state.strikes.saturating_add(1);
        let wait = wait_after(headers, state.strikes);
        state.budget.limited = true;
        state.budget.resets_at = Some(now_secs() + wait.max(1));
    } else if status.is_success() {
        state.strikes = 0;
    }
}

pub fn budget() -> Budget {
    let _ = check();
    STATE.lock().map(|state| state.budget).unwrap_or_default()
}

#[cfg(test)]
fn reset() {
    if let Ok(mut state) = STATE.lock() {
        state.budget = Budget::default();
        state.strikes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).expect("header"));
        }
        map
    }

    #[test]
    fn each_refusal_in_a_row_waits_longer_up_to_a_limit() {
        let none = HeaderMap::new();
        assert_eq!(wait_after(&none, 1), 60);
        assert_eq!(wait_after(&none, 2), 120);
        assert_eq!(wait_after(&none, 3), 240);
        assert_eq!(wait_after(&none, 20), LONGEST_WAIT_SECS);
        assert_eq!(wait_after(&headers(&[("retry-after", "7")]), 5), 7);
    }

    #[test]
    fn once_refused_nothing_is_sent_until_the_wait_is_over() {
        reset();
        observe(
            StatusCode::OK,
            &headers(&[
                ("x-ratelimit-limit", "1000"),
                ("x-ratelimit-nearlimit", "true"),
            ]),
        );
        assert!(check().is_ok());
        assert!(budget().near);
        assert_eq!(budget().limit, Some(1000));
        observe(StatusCode::TOO_MANY_REQUESTS, &HeaderMap::new());
        match check() {
            Err(BitbucketError::RateLimited { resets_in_secs }) => {
                assert!((59..=60).contains(&resets_in_secs))
            }
            other => panic!("expected to be held back, got {other:?}"),
        }
        reset();
        assert!(check().is_ok());
    }

    #[test]
    fn only_a_429_names_a_wait() {
        let after = headers(&[("retry-after", "2")]);
        assert_eq!(named_wait(StatusCode::TOO_MANY_REQUESTS, &after), Some(2));
        assert_eq!(named_wait(StatusCode::OK, &after), None);
        assert_eq!(
            named_wait(StatusCode::TOO_MANY_REQUESTS, &HeaderMap::new()),
            None
        );
    }
}
