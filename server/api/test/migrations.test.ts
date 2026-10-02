import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../src/db.ts";
import { migrate, readMigrations } from "../src/migrations.ts";
import { freshDatabase, log } from "./support.ts";

let dir: string;
let database: Database;
let drop: () => Promise<void>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sikemux-migrations-"));
  const fresh = await freshDatabase();
  drop = fresh.drop;
  database = openDatabase(fresh.url, log);
});

afterEach(async () => {
  await database.close();
  await drop();
  rmSync(dir, { recursive: true, force: true });
});

function write(files: Record<string, string>) {
  for (const [name, sql] of Object.entries(files))
    writeFileSync(join(dir, name), sql);
}

async function tables() {
  const { rows } = await database.pool.query<{ name: string }>(
    "select table_name as name from information_schema.tables where table_schema = 'public' order by 1",
  );
  return rows.map((row) => row.name);
}

describe("readMigrations", () => {
  it("reads the shipped migrations", async () => {
    await expect(
      readMigrations(fileURLToPath(new URL("../migrations", import.meta.url))),
    ).resolves.toBeDefined();
  });

  it("refuses a gap in the numbers", async () => {
    write({ "0001_a.sql": "", "0003_c.sql": "" });
    await expect(readMigrations(dir)).rejects.toThrow(
      "0003_c.sql should be number 0002",
    );
  });

  it("refuses files named any other way", async () => {
    write({ "1_a.sql": "" });
    await expect(readMigrations(dir)).rejects.toThrow("is not named like");
  });
});

describe("migrate", () => {
  it("applies new migrations in order, and only once", async () => {
    write({
      "0001_one.sql": "create table one (id int);",
      "0002_two.sql": "create table two (id int);",
    });
    const applied = await migrate(
      database.pool,
      await readMigrations(dir),
      log,
    );
    expect(applied.map((migration) => migration.name)).toEqual(["one", "two"]);
    expect(
      await migrate(database.pool, await readMigrations(dir), log),
    ).toEqual([]);
    expect(await tables()).toEqual(["one", "schema_migrations", "two"]);
  });

  it("rolls back a migration that fails and keeps the ones before it", async () => {
    write({
      "0001_one.sql": "create table one (id int);",
      "0002_bad.sql": "create table two (id int); select nonsense;",
    });
    await expect(
      migrate(database.pool, await readMigrations(dir), log),
    ).rejects.toThrow("Migration 2 (bad) failed and was rolled back.");
    expect(await tables()).toEqual(["one", "schema_migrations"]);
  });

  it("refuses to run after a shipped migration was edited", async () => {
    write({ "0001_one.sql": "create table one (id int);" });
    await migrate(database.pool, await readMigrations(dir), log);
    write({ "0001_one.sql": "create table one (id bigint);" });
    await expect(
      migrate(database.pool, await readMigrations(dir), log),
    ).rejects.toThrow("was changed after it ran");
  });

  it("refuses a build older than the database", async () => {
    write({
      "0001_one.sql": "create table one (id int);",
      "0002_two.sql": "create table two (id int);",
    });
    await migrate(database.pool, await readMigrations(dir), log);
    const older = (await readMigrations(dir)).slice(0, 1);
    await expect(migrate(database.pool, older, log)).rejects.toThrow(
      "which this build does not include",
    );
  });

  it("lets the process exit as soon as it is done", async () => {
    write({ "0001_one.sql": "create table one (id int);" });
    await migrate(database.pool, await readMigrations(dir), log);
    await database.close();
    expect(database.pool.ended).toBe(true);
  });

  it("lets only one deploy migrate at a time", async () => {
    write({
      "0001_slow.sql": "select pg_sleep(0.3); create table slow (id int);",
    });
    const migrations = await readMigrations(dir);
    const [first, second] = await Promise.all([
      migrate(database.pool, migrations, log),
      migrate(database.pool, migrations, log),
    ]);
    expect(first.length + second.length).toBe(1);
  });
});
