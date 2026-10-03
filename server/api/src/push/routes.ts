import type { PushTokenState } from "@sikemux/protocol";
import { Hono } from "hono";
import { sql } from "kysely";

import type { AuthEnv } from "../auth.ts";
import type { Database } from "../db.ts";
import { pushTokenMessage, signedBy } from "../devices/signature.ts";
import { ApiFailure, readBody } from "../http.ts";
import { limit, type RateLimiter } from "../limits.ts";
import type { PushSettings } from "./settings.ts";

const notYours = () =>
  new ApiFailure(404, "not_found", "None of your devices has that key.");

/** PUT and DELETE /v1/devices/{key}/push, mounted under the device routes, which sign the caller in. */
export function pushTokenRoutes(
  { db }: Database,
  limiter: RateLimiter,
  settings: Pick<PushSettings, "app" | "allowSandbox">,
) {
  const perUser = (name: string, perMinute: number) =>
    limit<AuthEnv>(limiter, name, perMinute, (c) => c.get("identity").userId);

  return new Hono<AuthEnv>()
    .put("/:key/push", perUser("push-token", 20), async (c) => {
      const { userId, via } = c.get("identity");
      const key = c.req.param("key");
      if (via !== "session")
        throw new ApiFailure(
          403,
          "forbidden",
          "Only the phone registers its push token.",
        );
      const registration = await readBody(c, "PushTokenRegistration");
      if (
        (registration.platform === "apns") !==
        (registration.apnsEnvironment !== undefined)
      )
        throw new ApiFailure(
          400,
          "bad_request",
          "APNs tokens say which environment issued them; FCM tokens do not.",
        );
      if (registration.app !== settings.app)
        throw new ApiFailure(
          400,
          "bad_request",
          `This server delivers only to the ${settings.app} app.`,
        );
      if (registration.apnsEnvironment === "sandbox" && !settings.allowSandbox)
        throw new ApiFailure(
          400,
          "bad_request",
          "This server does not deliver through Apple's sandbox.",
        );

      const challenge = await db
        .deleteFrom("challenges")
        .where("nonce", "=", registration.nonce)
        .where("user_id", "=", userId)
        .where("expires_at", ">", sql<Date>`now()`)
        .returning("nonce")
        .executeTakeFirst();
      if (!challenge)
        throw new ApiFailure(
          400,
          "bad_request",
          "The challenge is unknown, already used, or expired.",
        );

      const updatedAt = await db.transaction().execute(async (trx) => {
        const device = await trx
          .selectFrom("devices")
          .select("role")
          .where("key", "=", key)
          .where("user_id", "=", userId)
          .forUpdate()
          .executeTakeFirst();
        if (!device) throw notYours();
        if (device.role !== "client")
          throw new ApiFailure(
            400,
            "bad_request",
            "Only phones receive notifications.",
          );
        if (
          !signedBy(
            key,
            pushTokenMessage(registration.nonce, key, registration.token),
            registration.signature,
          )
        )
          throw new ApiFailure(
            403,
            "forbidden",
            "The signature does not prove this phone holds the key.",
          );

        await trx
          .deleteFrom("push_tokens")
          .where("token", "=", registration.token)
          .where("device_key", "<>", key)
          .execute();
        const fields = {
          platform: registration.platform,
          app: registration.app,
          apns_environment: registration.apnsEnvironment ?? null,
          token: registration.token,
        };
        const row = await trx
          .insertInto("push_tokens")
          .values({ device_key: key, ...fields })
          .onConflict((oc) =>
            oc.column("device_key").doUpdateSet({
              ...fields,
              updated_at: sql<Date>`now()`,
              last_ok_at: null,
              failures: 0,
            }),
          )
          .returning("updated_at")
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("audit")
          .values({
            user_id: userId,
            actor: `user:${userId}`,
            action: "push.enabled",
            subject: key,
            detail: JSON.stringify({ platform: registration.platform }),
          })
          .execute();
        return row.updated_at;
      });
      c.get("log").info(
        { key: key.slice(0, 8), platform: registration.platform },
        "stored a push token",
      );
      const body: PushTokenState = {
        enabled: true,
        updatedAt: updatedAt.toISOString(),
      };
      return c.json(body);
    })
    .delete("/:key/push", perUser("push-token", 20), async (c) => {
      const { userId } = c.get("identity");
      const key = c.req.param("key");
      const cleared = await db.transaction().execute(async (trx) => {
        const device = await trx
          .selectFrom("devices")
          .select("key")
          .where("key", "=", key)
          .where("user_id", "=", userId)
          .executeTakeFirst();
        if (!device) throw notYours();
        const removed = await trx
          .deleteFrom("push_tokens")
          .where("device_key", "=", key)
          .executeTakeFirst();
        if (removed.numDeletedRows > 0n)
          await trx
            .insertInto("audit")
            .values({
              user_id: userId,
              actor: `user:${userId}`,
              action: "push.disabled",
              subject: key,
            })
            .execute();
        return removed.numDeletedRows > 0n;
      });
      if (cleared)
        c.get("log").info({ key: key.slice(0, 8) }, "cleared a push token");
      return c.body(null, 204);
    });
}
