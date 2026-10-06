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
  rollBackUpdate,
  UpdateRefused,
  withdrawUpdate,
} from "./updates/publish.ts";

const UPDATE_COMMANDS = [
  "publish-update",
  "promote-update",
  "withdraw-update",
  "roll-back-update",
];
const MAX_DIRECTIVE_FILE_BYTES = 16 * 1024;

const updatesCertificate = () =>
  readFileSync(new URL("./updates-certificate.pem", import.meta.url), "utf8");

/** Reads the `{ directive, signature }` file CI sends to roll phones back. */
function readDirectiveFile(path: string) {
  const bytes = readFileSync(path);
  if (bytes.length > MAX_DIRECTIVE_FILE_BYTES)
    throw new UpdateRefused("The directive file is too large.");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new UpdateRefused("The directive file is not JSON.");
  }
  const { directive, signature } = (value ?? {}) as Record<string, unknown>;
  if (typeof directive !== "string" || typeof signature !== "string")
    throw new UpdateRefused(
      "The directive file must hold a directive and a signature, both strings.",
    );
  return { directive: Buffer.from(directive, "utf8"), signature };
}

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
} else if (UPDATE_COMMANDS.includes(command)) {
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
        certificate: updatesCertificate(),
      });
      log.info(
        published,
        published.added
          ? "published an update"
          : "the update was already published",
      );
    } else if (command === "withdraw-update") {
      if (!first) throw new UpdateRefused("usage: withdraw-update <update id>");
      const withdrawn = await withdrawUpdate(database.db, first);
      log.info(
        withdrawn,
        withdrawn.channels.length > 0
          ? "withdrew an update"
          : "the update was already withdrawn",
      );
    } else if (command === "roll-back-update") {
      if (!first || !second)
        throw new UpdateRefused(
          "usage: roll-back-update <update id> <directive file>",
        );
      const rolledBack = await rollBackUpdate(database.db, {
        id: first,
        ...readDirectiveFile(resolve(second)),
        certificate: updatesCertificate(),
      });
      log.info(rolledBack, "rolled phones back from an update");
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
    `unknown command; use serve, migrate, purge or ${UPDATE_COMMANDS.join(", ")}`,
  );
  process.exitCode = 2;
}
