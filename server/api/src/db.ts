import {
  Kysely,
  PostgresDialect,
  sql,
  type ColumnType,
  type Generated,
} from "kysely";
import pg from "pg";

import type { Logger } from "./log.ts";

type CreatedAt = ColumnType<Date, never, never>;

/** The tables the API reads and writes. Each one arrives with the migration that creates it. */
export interface Tables {
  users: { id: string; created_at: CreatedAt };
  devices: {
    key: string;
    user_id: string;
    role: string;
    name: string;
    platform: string;
    channel: string | null;
    created_at: CreatedAt;
    updated_at: ColumnType<Date, never, Date>;
    last_seen_at: Date | null;
  };
  challenges: { nonce: string; user_id: string; expires_at: Date };
  audit: {
    id: Generated<string>;
    user_id: string | null;
    actor: string;
    action: string;
    subject: string | null;
    detail: ColumnType<unknown, string | undefined, never>;
    at: CreatedAt;
  };
}

export interface Database {
  pool: pg.Pool;
  db: Kysely<Tables>;
  ping(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

export function openDatabase(url: string, log: Logger): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    application_name: "sikemux-api",
  });
  pool.on("error", (error) =>
    log.error({ err: error }, "an idle database connection failed"),
  );
  const db = new Kysely<Tables>({ dialect: new PostgresDialect({ pool }) });

  return {
    pool,
    db,
    async ping(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const query = sql`select 1`.execute(db).then(
        () => true,
        (error: unknown) => {
          log.warn({ err: error }, "the database did not answer");
          return false;
        },
      );
      try {
        return await Promise.race([query, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await db.destroy();
      if (!pool.ended) await pool.end();
    },
  };
}
