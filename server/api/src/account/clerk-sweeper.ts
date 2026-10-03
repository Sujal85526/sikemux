import { sql, type Kysely } from "kysely";

import type { Tables } from "../db.ts";
import type { Logger } from "../log.ts";
import type { ClerkBackend } from "./clerk.ts";
import { deleteInClerk, revokeRemovedSession } from "./deletion.ts";

const BATCH = 20;

/** Retries every call to Clerk that failed and is due again. */
export async function sweepClerk(
  db: Kysely<Tables>,
  clerk: ClerkBackend,
  log: Logger,
): Promise<void> {
  const users = await db
    .selectFrom("users")
    .select("id")
    .where("deleted_at", "is not", null)
    .where("clerk_deleted_at", "is", null)
    .where("clerk_retry_at", "<=", sql<Date>`now()`)
    .orderBy("clerk_retry_at")
    .limit(BATCH)
    .execute();
  for (const { id } of users) await deleteInClerk(db, clerk, log, id);

  const sessions = await db
    .selectFrom("removed_devices")
    .select("key")
    .where("clerk_session_id", "is not", null)
    .where("clerk_revoked_at", "is", null)
    .where("clerk_retry_at", "<=", sql<Date>`now()`)
    .orderBy("clerk_retry_at")
    .limit(BATCH)
    .execute();
  for (const { key } of sessions)
    await revokeRemovedSession(db, clerk, log, key);
}
