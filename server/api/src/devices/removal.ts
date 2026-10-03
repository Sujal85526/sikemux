import type { DeviceRole, RevokeReason } from "@sikemux/protocol";
import type { Transaction } from "kysely";

import type { Tables } from "../db.ts";
import { appendEvent } from "../events/log.ts";

export interface Removal {
  userId: string;
  key: string;
  reason: RevokeReason;
  /** Who asked, for the audit log: `user:<id>`, `device:<key>` or `clerk`. */
  actor: string;
  detail?: Record<string, unknown>;
}

export interface Removed {
  key: string;
  role: DeviceRole;
  clerkSessionId: string | null;
}

/**
 * Takes a device off its account: the row moves to a tombstone that keeps its cursor, so a
 * device that was offline still learns why it is gone, and the account hears device.revoked.
 */
export async function removeDevice(
  trx: Transaction<Tables>,
  { userId, key, reason, actor, detail = {} }: Removal,
): Promise<Removed | undefined> {
  const row = await trx
    .deleteFrom("devices")
    .where("key", "=", key)
    .where("user_id", "=", userId)
    .returning(["key", "role", "name", "acked_event_id", "clerk_session_id"])
    .executeTakeFirst();
  if (!row) return undefined;
  await trx
    .insertInto("removed_devices")
    .values({
      key,
      user_id: userId,
      role: row.role,
      reason,
      acked_event_id: row.acked_event_id,
      clerk_session_id: row.clerk_session_id,
    })
    .execute();
  await appendEvent(trx, {
    userId,
    type: "device.revoked",
    subject: key,
    subjectRole: row.role as DeviceRole,
    reason,
  });
  await trx
    .insertInto("audit")
    .values({
      user_id: userId,
      actor,
      action: "device.removed",
      subject: key,
      detail: JSON.stringify({
        role: row.role,
        name: row.name,
        reason,
        ...detail,
      }),
    })
    .execute();
  return {
    key,
    role: row.role as DeviceRole,
    clerkSessionId: row.clerk_session_id,
  };
}
