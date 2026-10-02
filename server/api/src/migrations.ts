import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

import type { Logger } from "./log.ts";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Held while migrating, so two deploys can never change the schema at once. */
const LOCK = 73_550_401;

/** Reads `0001_name.sql`, `0002_name.sql`, … and refuses gaps, repeats and stray files. */
export async function readMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir))
    .filter((file) => !file.startsWith("."))
    .sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = FILE.exec(file);
    if (!match?.[1] || !match[2])
      throw new Error(`${file} is not named like 0001_create_users.sql`);
    const version = Number(match[1]);
    if (version !== migrations.length + 1) {
      throw new Error(
        `${file} should be number ${String(migrations.length + 1).padStart(4, "0")}`,
      );
    }
    const sql = await readFile(join(dir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    migrations.push({ version, name: match[2], sql, checksum });
  }
  return migrations;
}

/**
 * Applies every migration the database has not seen, each in its own transaction. A migration
 * that was changed after it ran, or one the database has but this build does not, stops it:
 * shipped migrations are never edited, only followed by new ones.
 */
export async function migrate(
  pool: pg.Pool,
  migrations: Migration[],
  log: Logger,
): Promise<Migration[]> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK]);
    await client.query(`
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{
      version: number;
      name: string;
      checksum: string;
    }>(
      "select version, name, checksum from schema_migrations order by version",
    );
    for (const row of rows) {
      const known = migrations[row.version - 1];
      if (!known) {
        throw new Error(
          `The database has migration ${row.version} (${row.name}), which this build does not include.`,
        );
      }
      if (known.checksum !== row.checksum) {
        throw new Error(
          `Migration ${row.version} (${row.name}) was changed after it ran. Add a new migration instead.`,
        );
      }
    }
    const pending = migrations.slice(rows.length);
    for (const migration of pending) {
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query(
          "insert into schema_migrations (version, name, checksum) values ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(
          `Migration ${migration.version} (${migration.name}) failed and was rolled back.`,
          {
            cause: error,
          },
        );
      }
      log.info(
        { version: migration.version, name: migration.name },
        "applied a migration",
      );
    }
    return pending;
  } finally {
    await client
      .query("select pg_advisory_unlock($1)", [LOCK])
      .catch(() => undefined);
    client.release();
  }
}
