import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createLogger } from "./log.ts";
import { migrate, readMigrations } from "./migrations.ts";
import { startServer } from "./server.ts";

const command = process.argv[2] ?? "serve";
const config = loadConfig(process.env);
const log = createLogger(config.logLevel);

process.on("unhandledRejection", (error) => {
  log.fatal({ err: error }, "an unhandled rejection");
  process.exit(1);
});

if (command === "serve") {
  startServer(config, log);
} else if (command === "migrate") {
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
  log.fatal({ command }, "unknown command; use serve or migrate");
  process.exitCode = 2;
}
