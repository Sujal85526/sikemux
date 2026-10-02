import { serve } from "@hono/node-server";
import type { Server } from "node:http";

import { createApp } from "./app.ts";
import { clerkVerifier } from "./auth.ts";
import type { Config } from "./config.ts";
import { openDatabase } from "./db.ts";
import type { Logger } from "./log.ts";

/** How long a stop waits for requests in flight before closing them anyway. */
const DRAIN_MS = 25_000;

export function startServer(config: Config, log: Logger) {
  const database = openDatabase(config.databaseUrl, log);
  const verifier = clerkVerifier({
    issuer: config.clerkIssuer,
    macClientId: config.macClientId,
    authorizedParties: [config.appOrigin],
  });
  const app = createApp({
    database,
    log,
    appOrigin: config.appOrigin,
    verifier,
  });
  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (address) =>
      log.info({ host: address.address, port: address.port }, "listening"),
  ) as Server;

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "stopping");
    const force = setTimeout(() => server.closeAllConnections(), DRAIN_MS);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      database.close().then(
        () => {
          log.info("stopped");
          process.exit(0);
        },
        (error: unknown) => {
          log.error({ err: error }, "closing the database failed");
          process.exit(1);
        },
      );
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
