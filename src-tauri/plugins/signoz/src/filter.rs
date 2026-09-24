use serde::Deserialize;

use crate::error::{SignozError, SignozResult};
use crate::query::{self, quote};

const MAX_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FilterOp {
    Equals,
    NotEquals,
    Contains,
    NotContains,
    Exists,
    NotExists,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Filter {
    pub key: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: String,
}

/// What every query narrows by, whichever signal it reads.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub service: Option<String>,
    pub environment: Option<String>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    /// A filter in SigNoz's own query syntax, for anything the others cannot say.
    pub expression: Option<String>,
    /// A fixed range in Unix milliseconds. Without one, the last `minutes`.
    pub start: Option<u64>,
    pub end: Option<u64>,
    pub minutes: Option<u32>,
}

/// Attribute names are written into the expression as they are, so only
/// characters a name can have get through.
fn checked_key(key: &str) -> SignozResult<&str> {
    let key = key.trim();
    let mut chars = key.chars();
    let starts_well = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '@');
    let rest_ok =
        chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ':' | '@' | '/'));
    if key.len() > 200 || !starts_well || !rest_ok {
        return Err(SignozError::BadArg(format!(
            "`{key}` is not an attribute name"
        )));
    }
    Ok(key)
}

pub fn clause(filter: &Filter) -> SignozResult<String> {
    let key = checked_key(&filter.key)?;
    let value = quote(&filter.value);
    Ok(match filter.op {
        FilterOp::Equals => format!("{key} = {value}"),
        FilterOp::NotEquals => format!("{key} != {value}"),
        FilterOp::Contains => format!("{key} CONTAINS {value}"),
        FilterOp::NotContains => format!("{key} NOT CONTAINS {value}"),
        FilterOp::Exists => format!("{key} EXISTS"),
        FilterOp::NotExists => format!("NOT ({key} EXISTS)"),
    })
}

fn present(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

impl Scope {
    pub fn clauses(&self) -> SignozResult<Vec<String>> {
        let mut clauses = Vec::new();
        if let Some(service) = present(&self.service) {
            clauses.push(format!("service.name = {}", quote(service)));
        }
        if let Some(environment) = present(&self.environment) {
            clauses.push(format!("deployment.environment = {}", quote(environment)));
        }
        for filter in &self.filters {
            clauses.push(clause(filter)?);
        }
        if let Some(expression) = present(&self.expression) {
            clauses.push(expression.to_string());
        }
        Ok(clauses)
    }

    pub fn window(&self) -> (u64, u64) {
        match (self.start, self.end) {
            (Some(start), Some(end)) if start < end => {
                (start.max(end.saturating_sub(MAX_WINDOW_MS)), end)
            }
            _ => query::window(self.minutes),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(key: &str, op: FilterOp, value: &str) -> Filter {
        Filter {
            key: key.into(),
            op,
            value: value.into(),
        }
    }

    #[test]
    fn writes_each_operator_in_signoz_syntax() {
        assert_eq!(
            clause(&filter("path", FilterOp::Equals, "/a")).unwrap(),
            "path = '/a'"
        );
        assert_eq!(
            clause(&filter("path", FilterOp::NotEquals, "/a")).unwrap(),
            "path != '/a'"
        );
        assert_eq!(
            clause(&filter("body", FilterOp::NotContains, "it's")).unwrap(),
            "body NOT CONTAINS 'it\\'s'"
        );
        assert_eq!(
            clause(&filter("code.file.path", FilterOp::Exists, "")).unwrap(),
            "code.file.path EXISTS"
        );
        assert_eq!(
            clause(&filter("user_id", FilterOp::NotExists, "")).unwrap(),
            "NOT (user_id EXISTS)"
        );
    }

    #[test]
    fn refuses_names_that_could_change_the_query() {
        for key in ["path = 'x' OR 1", "a b", "", "'quoted'", "(path)", "9lives"] {
            assert!(
                clause(&filter(key, FilterOp::Equals, "x")).is_err(),
                "{key} should be refused"
            );
        }
    }

    #[test]
    fn scopes_by_service_environment_filters_and_expression() {
        let scope = Scope {
            service: Some("api".into()),
            environment: Some("production".into()),
            filters: vec![filter("status", FilterOp::Equals, "503")],
            expression: Some("latency_ms > 100".into()),
            ..Scope::default()
        };
        assert_eq!(
            scope.clauses().unwrap(),
            [
                "service.name = 'api'",
                "deployment.environment = 'production'",
                "status = '503'",
                "latency_ms > 100"
            ]
        );
    }

    #[test]
    fn keeps_a_fixed_range_but_never_more_than_a_week() {
        let week = MAX_WINDOW_MS;
        let fixed = Scope {
            start: Some(1_000),
            end: Some(5_000),
            ..Scope::default()
        };
        assert_eq!(fixed.window(), (1_000, 5_000));
        let huge = Scope {
            start: Some(0),
            end: Some(week * 3),
            ..Scope::default()
        };
        assert_eq!(huge.window(), (week * 2, week * 3));
        let backwards = Scope {
            start: Some(5_000),
            end: Some(1_000),
            minutes: Some(5),
            ..Scope::default()
        };
        let (start, end) = backwards.window();
        assert_eq!(end - start, 5 * 60_000);
    }
}
