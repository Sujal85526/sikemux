import type {
  AccountEvent,
  AccountEventType,
  DeviceRole,
  LiveRole,
  RevokeReason,
} from "@sikemux/protocol";
import type { ExpressionBuilder, Kysely, SqlBool, Expression } from "kysely";

import type { Tables } from "../db.ts";

/**
 * Which of an account's events a connection may read. Hosts learn of phones only when one is
 * revoked; phones never learn of other phones; the web app sees the whole account.
 */
export function visibleTo(role: LiveRole, ownKey: string | null) {
  return (eb: ExpressionBuilder<Tables, "events">): Expression<SqlBool> => {
    if (role === "web") return eb.lit(true);
    const own = ownKey === null ? eb.lit(false) : eb("subject", "=", ownKey);
    const accountDeleted = eb("type", "=", "account.deleted");
    if (role === "host")
      return eb.or([
        own,
        accountDeleted,
        eb.and([
          eb("type", "=", "device.revoked"),
          eb("subject_role", "=", "client"),
        ]),
      ]);
    return eb.or([own, accountDeleted, eb("subject_role", "=", "host")]);
  };
}

export interface BacklogQuery {
  userId: string;
  role: LiveRole;
  key: string | null;
  after: number;
  limit: number;
}

/** The events after `after` that the connection may read, oldest first. */
export async function backlog(
  db: Kysely<Tables>,
  { userId, role, key, after, limit }: BacklogQuery,
): Promise<AccountEvent[]> {
  const rows = await db
    .selectFrom("events")
    .select(["id", "type", "subject", "subject_role", "reason", "at"])
    .where("user_id", "=", userId)
    .where("id", ">", String(after))
    .where(visibleTo(role, key))
    .orderBy("id")
    .limit(limit)
    .execute();
  return rows.map((row) => {
    const event: AccountEvent = {
      id: Number(row.id),
      type: row.type as AccountEventType,
      at: row.at.toISOString(),
    };
    if (row.subject) event.key = row.subject;
    if (row.subject_role) event.role = row.subject_role as DeviceRole;
    if (row.reason) event.reason = row.reason as RevokeReason;
    return event;
  });
}
