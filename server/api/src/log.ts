import { pino, type Level, type Logger } from "pino";

import { version } from "./version.ts";

export type { Logger };

/** One JSON object per line on stdout, which journald keeps and the log shipper reads. */
export function createLogger(level: Level | "silent"): Logger {
  return pino({
    level,
    base: { service: "sikemux-api", version },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie"],
      remove: true,
    },
  });
}
