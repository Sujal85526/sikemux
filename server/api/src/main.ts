import { fileURLToPath } from "node:url";

import type { Level } from "pino";

import { loadConfig, loadMigrationConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createLogger } from "./log.ts";
import { migrate, readMigrations } from "./migrations.ts";
import { startServer } from "./server.ts";

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
} else {
  startLogging("info").fatal(
    { command },
    "unknown command; use serve or migrate",
  );
  process.exitCode = 2;
}
