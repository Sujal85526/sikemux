// What a query returns, the same for every engine: columns, rows of JSON
// values, and how many rows a change touched. Cells are made safe for JSON
// and for a grid: huge integers stay exact as text, and long text is cut.

use serde::Serialize;
use serde_json::Value;

pub const DEFAULT_ROW_LIMIT: usize = 500;
pub const MAX_ROW_LIMIT: usize = 10_000;
/// Characters a single cell keeps; the rest is cut, so one huge document cannot swamp a result.
const CELL_CHARACTERS: usize = 4_000;
/// The largest integer a JavaScript number holds exactly.
const SAFE_INTEGER: i64 = (1 << 53) - 1;
const BLOB_PREVIEW_BYTES: usize = 32;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// The engine's own name for the type, such as `int4` or `TEXT`; empty when it does not say.
    #[serde(rename = "type")]
    pub type_name: String,
    /// Numbers sit to the right in a grid.
    pub numeric: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    /// More rows came back than the limit, and only the first ones are kept.
    pub truncated: bool,
    /// Rows a change touched; absent for statements that return rows.
    pub affected: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutcome {
    /// One result per statement, in the order they ran.
    pub results: Vec<ResultSet>,
    pub millis: u64,
}

/// The row limit asked for, kept within reason.
pub fn row_limit(asked: Option<usize>) -> usize {
    asked.unwrap_or(DEFAULT_ROW_LIMIT).clamp(1, MAX_ROW_LIMIT)
}

pub fn text(value: &str) -> Value {
    match value.char_indices().nth(CELL_CHARACTERS) {
        Some((cut, _)) => Value::String(format!("{}…", value.get(..cut).unwrap_or(value))),
        None => Value::String(value.to_string()),
    }
}

pub fn integer(value: i64) -> Value {
    if (-SAFE_INTEGER..=SAFE_INTEGER).contains(&value) {
        Value::from(value)
    } else {
        Value::String(value.to_string())
    }
}

pub fn real(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map_or_else(|| Value::String(value.to_string()), Value::Number)
}

/// Binary data as the start of its hex, with its full size.
pub fn blob(bytes: &[u8]) -> Value {
    let shown: String = bytes
        .iter()
        .take(BLOB_PREVIEW_BYTES)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if bytes.len() > BLOB_PREVIEW_BYTES {
        Value::String(format!("\\x{shown}… ({} bytes)", bytes.len()))
    } else {
        Value::String(format!("\\x{shown}"))
    }
}

/// Whether a type name, as an engine spells it, holds numbers.
pub fn is_numeric_type(type_name: &str) -> bool {
    let upper = type_name.to_ascii_uppercase();
    [
        "INT", "REAL", "FLOA", "DOUB", "NUMERIC", "DECIMAL", "SERIAL", "MONEY",
    ]
    .iter()
    .any(|part| upper.contains(part))
}

/// Columns with no declared type, such as `count(*)`, count as numbers when every value they hold is one.
pub fn infer_numeric(columns: &mut [Column], rows: &[Vec<Value>]) {
    for (index, column) in columns.iter_mut().enumerate() {
        if !column.type_name.is_empty() {
            continue;
        }
        let mut values = rows
            .iter()
            .filter_map(|row| row.get(index))
            .filter(|value| !value.is_null())
            .peekable();
        column.numeric = values.peek().is_some() && values.all(Value::is_number);
    }
}

pub fn elapsed_millis(started: std::time::Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_beyond_what_javascript_holds_stay_exact_as_text() {
        assert_eq!(integer(42), Value::from(42));
        assert_eq!(integer(SAFE_INTEGER), Value::from(SAFE_INTEGER));
        assert_eq!(integer(i64::MAX), Value::String(i64::MAX.to_string()));
        assert_eq!(integer(i64::MIN), Value::String(i64::MIN.to_string()));
    }

    #[test]
    fn reals_that_json_cannot_hold_are_written_out() {
        assert_eq!(real(1.5), Value::from(1.5));
        assert_eq!(real(f64::NAN), Value::String("NaN".into()));
        assert_eq!(real(f64::INFINITY), Value::String("inf".into()));
    }

    #[test]
    fn long_text_is_cut_on_a_character_boundary() {
        let long = "é".repeat(CELL_CHARACTERS + 10);
        let Value::String(cut) = text(&long) else {
            panic!("expected text")
        };
        assert_eq!(cut.chars().count(), CELL_CHARACTERS + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(text("short"), Value::String("short".into()));
    }

    #[test]
    fn blobs_show_their_start_and_size() {
        assert_eq!(blob(&[0xde, 0xad]), Value::String("\\xdead".into()));
        let Value::String(long) = blob(&[0u8; 100]) else {
            panic!("expected text")
        };
        assert!(long.ends_with("… (100 bytes)"), "{long}");
    }

    #[test]
    fn numeric_types_are_known_by_name_or_by_their_values() {
        assert!(is_numeric_type("int4"));
        assert!(is_numeric_type("NUMERIC(10,2)"));
        assert!(is_numeric_type("double precision"));
        assert!(!is_numeric_type("text"));
        assert!(!is_numeric_type("timestamptz"));
        let column = |name: &str| Column {
            name: name.into(),
            type_name: String::new(),
            numeric: false,
        };
        let mut columns = vec![column("count"), column("label"), column("empty")];
        let rows = vec![
            vec![Value::from(3), Value::from("a"), Value::Null],
            vec![Value::Null, Value::from(1), Value::Null],
        ];
        infer_numeric(&mut columns, &rows);
        let numeric: Vec<bool> = columns.iter().map(|column| column.numeric).collect();
        assert_eq!(numeric, vec![true, false, false]);
    }

    #[test]
    fn the_row_limit_stays_within_reason() {
        assert_eq!(row_limit(None), DEFAULT_ROW_LIMIT);
        assert_eq!(row_limit(Some(0)), 1);
        assert_eq!(row_limit(Some(1_000_000)), MAX_ROW_LIMIT);
    }
}
