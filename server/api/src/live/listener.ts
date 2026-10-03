import pg from "pg";

import { EVENTS_CHANNEL } from "../events/log.ts";
import type { Logger } from "../log.ts";

export interface Listener {
  close(): Promise<void>;
}

const MAX_BACKOFF_MS = 30_000;
const ALERT_AFTER_MS = 60_000;

/**
 * Holds one connection outside the pool that listens for account events. When it drops, it
 * reconnects with backoff and then calls `onReconnect`, since anything announced meanwhile is lost.
 */
export function listenForEvents(
  url: string,
  log: Logger,
  onEvent: (userId: string) => void,
  onReconnect: () => void,
): Listener {
  let client: pg.Client | undefined;
  let closed = false;
  let attempt = 0;
  let downSince: number | undefined;
  let retry: NodeJS.Timeout | undefined;

  const connect = async () => {
    const next = new pg.Client({
      connectionString: url,
      application_name: "sikemux-api-listener",
    });
    next.on("notification", (note) => {
      if (note.channel === EVENTS_CHANNEL && note.payload)
        onEvent(note.payload);
    });
    next.on("error", (error) => {
      log.warn({ err: error }, "the event listener's connection failed");
      lost(next);
    });
    next.on("end", () => lost(next));
    client = next;
    try {
      await next.connect();
      await next.query(`listen ${EVENTS_CHANNEL}`);
    } catch (error) {
      log.warn({ err: error }, "the event listener could not connect");
      lost(next);
      return;
    }
    if (closed) return;
    if (downSince !== undefined) {
      log.info(
        { downMs: Date.now() - downSince },
        "the event listener is back",
      );
      downSince = undefined;
      onReconnect();
    }
    attempt = 0;
  };

  const lost = (which: pg.Client) => {
    if (closed || client !== which) return;
    client = undefined;
    which.end().catch(() => undefined);
    downSince ??= Date.now();
    if (Date.now() - downSince > ALERT_AFTER_MS)
      log.error(
        { downMs: Date.now() - downSince },
        "the event listener has been down for over a minute",
      );
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    attempt += 1;
    retry = setTimeout(() => void connect(), delay);
  };

  void connect();

  return {
    async close() {
      closed = true;
      clearTimeout(retry);
      await client?.end().catch(() => undefined);
    },
  };
}
