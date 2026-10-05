import { serve } from "@hono/node-server";
import type { Server } from "node:http";

import { clerkBackend } from "./account/clerk.ts";
import { sweepClerk } from "./account/clerk-sweeper.ts";
import { createApp } from "./app.ts";
import { clerkVerifier } from "./auth.ts";
import type { Config } from "./config.ts";
import { openDatabase } from "./db.ts";
import { RateLimiter } from "./limits.ts";
import { attachLive } from "./live/server.ts";
import type { Logger } from "./log.ts";
import { FcmProvider } from "./push/fcm.ts";
import { Pusher } from "./push/send.ts";

/** How long a stop waits for requests in flight before closing them anyway. */
const DRAIN_MS = 25_000;
const CLERK_SWEEP_MS = 60_000;

export function startServer(config: Config, log: Logger) {
  const database = openDatabase(config.databaseUrl, log);
  const verifier = clerkVerifier({
    issuer: config.clerkIssuer,
    macClientId: config.macClientId,
    authorizedParties: [config.appOrigin],
  });
  const limiter = new RateLimiter();
  const clerk = config.clerkSecretKey
    ? clerkBackend(config.clerkSecretKey)
    : null;
  if (!clerk)
    log.warn(
      "CLERK_SECRET_KEY is not set: deleted accounts and removed phones' sessions wait to be deleted in Clerk",
    );
  if (!config.clerkWebhookSecret)
    log.warn("CLERK_WEBHOOK_SECRET is not set: Clerk's webhooks are refused");
  const fcm = config.push.fcm ? new FcmProvider(config.push.fcm) : null;
  if (fcm)
    log.info(
      { project: config.push.fcm?.projectId, app: config.push.app },
      "pushing to Android through FCM",
    );
  else
    log.warn(
      "FCM_SERVICE_ACCOUNT_FILE is not set: pushes to Android phones answer not_set_up",
    );
  log.info(
    {
      keyId: config.join.keyId,
      publicKey: config.join.publicKey,
      file: config.join.file,
      created: config.join.created,
    },
    "signing join tickets",
  );
  const pusher = new Pusher({
    db: database.db,
    log,
    limiter,
    providers: fcm ? { fcm } : {},
  });
  const app = createApp({
    database,
    log,
    appOrigin: config.appOrigin,
    verifier,
    limiter,
    clerk,
    webhookSecret: config.clerkWebhookSecret,
    network: config.network,
    push: config.push,
    join: config.join,
  });
  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (address) =>
      log.info({ host: address.address, port: address.port }, "listening"),
  ) as Server;
  const live = attachLive(server, {
    database,
    databaseUrl: config.databaseUrl,
    verifier,
    limiter,
    log,
    appOrigin: config.appOrigin,
    pusher,
  });

  let sweeping = false;
  const clerkSweep = setInterval(() => {
    if (!clerk || sweeping) return;
    sweeping = true;
    sweepClerk(database.db, clerk, log)
      .catch((error: unknown) =>
        log.error({ err: error }, "retrying calls to Clerk failed"),
      )
      .finally(() => {
        sweeping = false;
      });
  }, CLERK_SWEEP_MS);

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "stopping");
    clearInterval(clerkSweep);
    const force = setTimeout(() => server.closeAllConnections(), DRAIN_MS);
    force.unref();
    const liveStopped = live
      .stop()
      .catch((error: unknown) =>
        log.error({ err: error }, "closing live connections failed"),
      );
    server.close(() => {
      clearTimeout(force);
      liveStopped
        .then(() => database.close())
        .then(
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
