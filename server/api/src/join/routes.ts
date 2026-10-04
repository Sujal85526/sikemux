import { Hono } from "hono";

import type { AuthEnv } from "../auth.ts";
import type { Database } from "../db.ts";
import { ApiFailure, readBody } from "../http.ts";
import { limit, type RateLimiter } from "../limits.ts";
import { signTicket, type JoinSigner } from "./signer.ts";

/** POST /v1/devices/{key}/join, mounted under the device routes, which sign the caller in. */
export function joinRoutes(
  { db }: Database,
  limiter: RateLimiter,
  signer: JoinSigner,
) {
  const perPhone = limit<AuthEnv>(
    limiter,
    "join",
    10,
    (c) => `${c.get("identity").userId}:${c.req.param("key") ?? ""}`,
  );

  return new Hono<AuthEnv>().post("/:key/join", perPhone, async (c) => {
    const { userId, via } = c.get("identity");
    const phone = c.req.param("key");
    if (via !== "session")
      throw new ApiFailure(
        403,
        "forbidden",
        "Only the phone asks for a ticket to join a host.",
      );
    const { host } = await readBody(c, "JoinRequest");

    const devices = await db
      .selectFrom("devices")
      .select(["key", "role"])
      .where("user_id", "=", userId)
      .where("key", "in", [phone, host])
      .execute();
    if (!devices.some((d) => d.key === phone && d.role === "client"))
      throw new ApiFailure(
        404,
        "not_found",
        "None of your phones has that key.",
      );
    if (!devices.some((d) => d.key === host && d.role === "host"))
      throw new ApiFailure(
        404,
        "not_found",
        "None of your hosts has that key.",
      );

    const ticket = signTicket(signer, { account: userId, host, phone });
    await db
      .insertInto("audit")
      .values({
        user_id: userId,
        actor: `user:${userId}`,
        action: "join.issued",
        subject: phone,
        detail: JSON.stringify({ host, keyId: ticket.keyId }),
      })
      .execute();
    c.get("log").info(
      { phone: phone.slice(0, 8), host: host.slice(0, 8) },
      "issued a join ticket",
    );
    return c.json(ticket);
  });
}
