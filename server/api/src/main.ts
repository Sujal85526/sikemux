import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Level } from "pino";

import { purgeAccounts, pruneHistory } from "./account/purge.ts";
import { loadConfig, loadMigrationConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createLogger } from "./log.ts";
import { migrate, readMigrations } from "./migrations.ts";
import { startServer } from "./server.ts";
import {
  promoteUpdate,
  publishUpdate,
  UpdateRefused,
} from "./updates/publish.ts";

function startLogging(level: Level) {
  const log = createLogger(level);
  process.on("unhandledRejection", (error) => {
    log.fatal({ err: error }, "an unhandled rejection");
    process.exit(1);
  });
  return log;
}

const command = process.argv[2] ?? "serve";

if (command === "serve") {
  const config = loadConfig(process.env);
  startServer(config, startLogging(config.logLevel));
} else if (command === "migrate") {
  const config = loadMigrationConfig(process.env);
  const log = startLogging(config.logLevel);
  const database = openDatabase(config.databaseUrl, log);
  try {
    const migrations = await readMigrations(
      fileURLToPath(new URL("../migrations", import.meta.url)),
    );
    const applied = await migrate(database.pool, migrations, log);
    log.info(
      { applied: applied.length, total: migrations.length },
      "the database is up to date",
    );
  } catch (error) {
    log.fatal({ err: error }, "migrating failed");
    process.exitCode = 1;
  } finally {
    await database.close();
  }
} else if (command === "publish-update" || command === "promote-update") {
  const config = loadMigrationConfig(process.env);
  const log = startLogging(config.logLevel);
  const [first, second] = process.argv.slice(3);
  const database = openDatabase(config.databaseUrl, log);
  try {
    if (command === "publish-update") {
      if (!first || !second)
        throw new UpdateRefused(
          "usage: publish-update <unpacked bundle> <asset folder>",
        );
      const published = await publishUpdate(database.db, {
        dir: resolve(first),
        assetsDir: resolve(second),
        certificate: readFileSync(
          new URL("./updates-certificate.pem", import.meta.url),
          "utf8",
        ),
      });
      log.info(
        published,
        published.added
          ? "published an update"
          : "the update was already published",
      );
    } else {
      if (!first) throw new UpdateRefused("usage: promote-update <update id>");
      const promoted = await promoteUpdate(database.db, first);
      log.info(
        promoted,
        promoted.added
          ? "promoted an update to stable"
          : "the update is already on stable",
      );
    }
  } catch (error) {
    if (error instanceof UpdateRefused) log.error(error.message);
    else log.fatal({ err: error }, `${command} failed`);
    process.exitCode = 1;
  } finally {
    await database.close();
  }
} else if (command === "purge") {
  const config = loadMigrationConfig(process.env);
  const log = startLogging(config.logLevel);
  const database = openDatabase(config.databaseUrl, log);
  try {
    await purgeAccounts(database.db, log);
    await pruneHistory(database.db, log);
  } catch (error) {
    log.fatal({ err: error }, "purging failed");
    process.exitCode = 1;
  } finally {
    await database.close();
  }
} else {
  startLogging("info").fatal(
    { command },
    "unknown command; use serve, migrate, purge, publish-update or promote-update",
  );
  process.exitCode = 2;
}
