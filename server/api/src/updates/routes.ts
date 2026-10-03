import { randomBytes } from "node:crypto";
import { Hono } from "hono";

import type { Database } from "../db.ts";
import { ApiFailure, type Env } from "../http.ts";
import { clientAddress, limit, type RateLimiter } from "../limits.ts";
import {
  CHANNELS,
  isChannel,
  isPlatform,
  PLATFORMS,
  RUNTIME_VERSION,
} from "./update.ts";

const RESPONSE_HEADERS = {
  "expo-protocol-version": "1",
  "expo-sfv-version": "0",
  "cache-control": "private, max-age=0",
};

/** Expo's update protocol, version 1. Phones send headers, not JSON, so it sits outside /v1. */
export function updateRoutes({ db }: Database, limiter: RateLimiter) {
  return new Hono<Env>().get(
    "/manifest",
    limit<Env>(limiter, "manifest", 120, clientAddress),
    async (c) => {
      const protocolVersion = c.req.header("expo-protocol-version");
      const platform = c.req.header("expo-platform");
      const runtimeVersion = c.req.header("expo-runtime-version");
      const channel = c.req.header("expo-channel-name");
      if (protocolVersion !== "1")
        throw new ApiFailure(
          400,
          "bad_request",
          "expo-protocol-version must be 1.",
        );
      if (!isPlatform(platform))
        throw new ApiFailure(
          400,
          "bad_request",
          `expo-platform is one of ${PLATFORMS.join(", ")}.`,
        );
      if (!runtimeVersion || !RUNTIME_VERSION.test(runtimeVersion))
        throw new ApiFailure(
          400,
          "bad_request",
          "expo-runtime-version is missing or malformed.",
        );
      if (!isChannel(channel))
        throw new ApiFailure(
          400,
          "bad_request",
          `expo-channel-name is one of ${CHANNELS.join(", ")}.`,
        );

      const update = await db
        .selectFrom("updates")
        .innerJoin("update_channels", "update_channels.update_id", "updates.id")
        .select(["updates.id", "updates.manifest", "updates.signature"])
        .where("updates.platform", "=", platform)
        .where("updates.runtime_version", "=", runtimeVersion)
        .where("update_channels.channel", "=", channel)
        .orderBy("updates.created_at", "desc")
        .orderBy("updates.published_at", "desc")
        .limit(1)
        .executeTakeFirst();

      for (const [name, value] of Object.entries(RESPONSE_HEADERS))
        c.header(name, value);
      // Protocol 1 reads an empty 204 as "nothing new", which needs no signature.
      if (!update) return c.body(null, 204);

      const boundary = boundaryFor(update.manifest);
      const head = Buffer.from(
        [
          `--${boundary}`,
          "content-type: application/json; charset=utf-8",
          'content-disposition: form-data; name="manifest"',
          `expo-signature: sig="${update.signature}", keyid="main", alg="rsa-v1_5-sha256"`,
          "",
          "",
        ].join("\r\n"),
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      c.header("content-type", `multipart/mixed; boundary=${boundary}`);
      return c.body(
        new Uint8Array(Buffer.concat([head, update.manifest, tail])),
      );
    },
  );
}

function boundaryFor(manifest: Buffer): string {
  for (;;) {
    const boundary = `sikemux-${randomBytes(16).toString("hex")}`;
    if (!manifest.includes(boundary)) return boundary;
  }
}
