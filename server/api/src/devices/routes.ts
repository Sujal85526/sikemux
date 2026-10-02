import { randomBytes } from "node:crypto";
import type {
  Challenge,
  Channel,
  Device,
  DeviceList,
  DeviceRole,
  Platform,
} from "@sikemux/protocol";
import { Hono } from "hono";
import { sql, type Selectable } from "kysely";

import { requireIdentity, type AuthEnv, type Verifier } from "../auth.ts";
import type { Database, Tables } from "../db.ts";
import { ApiFailure, readBody } from "../http.ts";
import { limit, type RateLimiter } from "../limits.ts";
import { registrationMessage, signedBy } from "./signature.ts";

const CHALLENGE_MS = 2 * 60_000;
const ROLES: readonly DeviceRole[] = ["host", "client"];

function toDevice(row: Selectable<Tables["devices"]>): Device {
  const device: Device = {
    key: row.key,
    role: row.role as DeviceRole,
    name: row.name,
    platform: row.platform as Platform,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
  };
  if (row.channel) device.channel = row.channel as Channel;
  return device;
}

export function deviceRoutes(
  { db }: Database,
  verifier: Verifier,
  limiter: RateLimiter,
) {
  const perUser = (name: string, perMinute: number) =>
    limit<AuthEnv>(limiter, name, perMinute, (c) => c.get("identity").userId);

  return new Hono<AuthEnv>()
    .use(requireIdentity(verifier))
    .post("/challenge", perUser("challenge", 30), async (c) => {
      const { userId } = c.get("identity");
      const nonce = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + CHALLENGE_MS);
      await db
        .deleteFrom("challenges")
        .where("expires_at", "<", sql<Date>`now() - interval '1 hour'`)
        .execute();
      await db
        .insertInto("challenges")
        .values({ nonce, user_id: userId, expires_at: expiresAt })
        .execute();
      const body: Challenge = { nonce, expiresAt: expiresAt.toISOString() };
      return c.json(body);
    })
    .post("/", perUser("register", 20), async (c) => {
      const { userId } = c.get("identity");
      const registration = await readBody(c, "DeviceRegistration");
      if (
        (registration.role === "host") !==
        (registration.channel !== undefined)
      ) {
        throw new ApiFailure(
          400,
          "bad_request",
          "Hosts say which channel they run; clients do not.",
        );
      }
      const name = registration.name.trim();
      if (!name)
        throw new ApiFailure(400, "bad_request", "The device needs a name.");

      const challenge = await db
        .deleteFrom("challenges")
        .where("nonce", "=", registration.nonce)
        .where("user_id", "=", userId)
        .where("expires_at", ">", sql<Date>`now()`)
        .returning("nonce")
        .executeTakeFirst();
      if (!challenge) {
        throw new ApiFailure(
          400,
          "bad_request",
          "The challenge is unknown, already used, or expired.",
        );
      }
      const message = registrationMessage(
        registration.nonce,
        userId,
        registration.key,
      );
      if (!signedBy(registration.key, message, registration.signature)) {
        throw new ApiFailure(
          403,
          "forbidden",
          "The signature does not prove this device holds the key.",
        );
      }

      const { row, added } = await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("users")
          .values({ id: userId })
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();
        const existing = await trx
          .selectFrom("devices")
          .selectAll()
          .where("key", "=", registration.key)
          .forUpdate()
          .executeTakeFirst();
        if (existing && existing.user_id !== userId) {
          throw new ApiFailure(
            409,
            "conflict",
            "This device is registered to another account.",
          );
        }
        if (existing && existing.role !== registration.role) {
          throw new ApiFailure(
            409,
            "conflict",
            `This device is already registered as a ${existing.role}.`,
          );
        }
        const fields = {
          name,
          platform: registration.platform,
          channel: registration.channel ?? null,
        };
        const row = existing
          ? await trx
              .updateTable("devices")
              .set({ ...fields, updated_at: sql<Date>`now()` })
              .where("key", "=", registration.key)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await trx
              .insertInto("devices")
              .values({
                key: registration.key,
                user_id: userId,
                role: registration.role,
                ...fields,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
        await trx
          .insertInto("audit")
          .values({
            user_id: userId,
            actor: `user:${userId}`,
            action: existing ? "device.updated" : "device.registered",
            subject: registration.key,
            detail: JSON.stringify({
              role: row.role,
              name: row.name,
              platform: row.platform,
              via: c.get("identity").via,
            }),
          })
          .execute();
        return { row, added: !existing };
      });
      c.get("log").info(
        { key: row.key, role: row.role, added },
        added ? "registered a device" : "updated a device",
      );
      return c.json(toDevice(row), added ? 201 : 200);
    })
    .delete("/:key", perUser("remove", 30), async (c) => {
      const { userId, via } = c.get("identity");
      const key = c.req.param("key");
      const removed = await db.transaction().execute(async (trx) => {
        const row = await trx
          .deleteFrom("devices")
          .where("key", "=", key)
          .where("user_id", "=", userId)
          .returning(["key", "role", "name"])
          .executeTakeFirst();
        if (row) {
          await trx
            .insertInto("audit")
            .values({
              user_id: userId,
              actor: `user:${userId}`,
              action: "device.removed",
              subject: key,
              detail: JSON.stringify({ role: row.role, name: row.name, via }),
            })
            .execute();
        }
        return row;
      });
      if (!removed)
        throw new ApiFailure(
          404,
          "not_found",
          "None of your devices has that key.",
        );
      c.get("log").info({ key, role: removed.role }, "removed a device");
      return c.body(null, 204);
    })
    .get("/", perUser("list", 120), async (c) => {
      const { userId } = c.get("identity");
      const role = c.req.query("role");
      if (role !== undefined && !ROLES.includes(role as DeviceRole)) {
        throw new ApiFailure(
          400,
          "bad_request",
          `role is one of ${ROLES.join(", ")}.`,
        );
      }
      let query = db
        .selectFrom("devices")
        .selectAll()
        .where("user_id", "=", userId);
      if (role) query = query.where("role", "=", role);
      const rows = await query.orderBy("created_at", "desc").execute();
      const body: DeviceList = { devices: rows.map(toDevice) };
      return c.json(body);
    });
}
