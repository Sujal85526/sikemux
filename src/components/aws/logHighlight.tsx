import { type ReactNode } from "react";

// Lightweight syntax highlighter for CloudWatch / aws-logs-tail output.
// Tokenises each log line on a single mega-regex with named alternates,
// then emits coloured spans. No ANSI parsing — we run aws with NO_COLOR
// already, and the structure-based highlight is more consistent than what
// the AWS CLI emits anyway. Cheap: one regex pass per line, called from
// AwsLogTailView's render so it's amortised across the virtualised list.

// Order matters — longer / more-specific patterns first so they win over
// shorter overlapping ones (e.g. an ISO timestamp must beat the bare-
// number rule that would otherwise eat its year).
//
// Each alternate uses a unique named capture group; the group that
// matched tells us which CSS token class to emit.
const TOK = new RegExp(
  [
    // ISO 8601 timestamp anywhere in the line:
    //   2026-05-26T13:45:23(.123)(Z | +05:30 | -0500)
    "(?<ts>\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)",
    // Plain HH:MM:SS prefix (Rundeck-style log entries use this).
    "(?<clock>\\b\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?\\b)",
    // Log levels — bracketed [INFO] or bare INFO. Captured wrapper kept
    // so the brackets get the same color as the level itself.
    "(?<lvl_err>\\[?\\b(?:ERROR|ERR|FATAL|CRITICAL|PANIC|SEVERE)\\b\\]?)",
    "(?<lvl_warn>\\[?\\b(?:WARN|WARNING)\\b\\]?)",
    "(?<lvl_info>\\[?\\b(?:INFO|INFORMATIONAL|NOTICE)\\b\\]?)",
    "(?<lvl_debug>\\[?\\b(?:DEBUG|TRACE|VERBOSE)\\b\\]?)",
    // HTTP methods + status codes — useful for any request-log line.
    "(?<method>\\b(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\\b)",
    "(?<status5>\\b5\\d{2}\\b)",
    "(?<status4>\\b4\\d{2}\\b)",
    "(?<status3>\\b3\\d{2}\\b)",
    "(?<status2>\\b2\\d{2}\\b)",
    // URLs (http/https/ws/wss/s3).
    "(?<url>(?:https?|wss?|s3):\\/\\/[\\w@:%._+~#=/?&-]+)",
    // UUID v4-ish — task ARNs, request ids, trace ids.
    "(?<uuid>\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b)",
    // IPv4.
    "(?<ip>\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(?::\\d+)?\\b)",
    // JSON-ish key: "name":
    '(?<jkey>"[^"\\\\]+"\\s*:)',
    // JSON-ish string value (delimited by quotes, allows simple escapes).
    '(?<jstr>"(?:[^"\\\\]|\\\\.)*")',
    // Booleans / null.
    "(?<bool>\\b(?:true|false|null|None|True|False)\\b)",
    // Bare number (after URLs/UUIDs/IPs to avoid eating their digits).
    "(?<num>\\b\\d+(?:\\.\\d+)?\\b)",
    // Bracketed tag — [foo] / [task/abc].
    "(?<tag>\\[[^\\]\\s]{1,40}\\])",
  ].join("|"),
  "gi",
);

const CLASS_FOR_GROUP: Record<string, string> = {
  ts: "lt-ts",
  clock: "lt-ts",
  lvl_err: "lt-lvl-err",
  lvl_warn: "lt-lvl-warn",
  lvl_info: "lt-lvl-info",
  lvl_debug: "lt-lvl-debug",
  method: "lt-method",
  status5: "lt-status-5",
  status4: "lt-status-4",
  status3: "lt-status-3",
  status2: "lt-status-2",
  url: "lt-url",
  uuid: "lt-uuid",
  ip: "lt-ip",
  jkey: "lt-jkey",
  jstr: "lt-jstr",
  bool: "lt-bool",
  num: "lt-num",
  tag: "lt-tag",
};

/** Tokenise a single log line into coloured spans. Returns a flat array
 *  of React nodes (strings + spans) that the caller drops straight into
 *  the log row. Returns the original string unchanged when nothing
 *  matches (which is normal for plain prose lines). */
export function highlightLog(text: string): ReactNode[] {
  if (!text) return [text];
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const m of text.matchAll(TOK)) {
    const idx = m.index ?? 0;
    if (idx > cursor) out.push(text.slice(cursor, idx));
    // Find which named group caught — `m.groups` only contains keys for
    // groups that participated, so the first defined value wins.
    const groups = m.groups ?? {};
    let cls: string | undefined;
    let value: string | undefined;
    for (const g of Object.keys(CLASS_FOR_GROUP)) {
      if (groups[g] !== undefined) {
        cls = CLASS_FOR_GROUP[g];
        value = groups[g];
        break;
      }
    }
    if (cls && value !== undefined) {
      out.push(
        <span key={key++} className={`lt ${cls}`}>
          {value}
        </span>,
      );
    } else {
      // Shouldn't happen — but fail open with the literal match.
      out.push(m[0]);
    }
    cursor = idx + m[0].length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
