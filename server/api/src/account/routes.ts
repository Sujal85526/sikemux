import type { AccountDeletion } from "@sikemux/protocol";
import { Hono } from "hono";

import { requireIdentity, type AuthEnv, type Verifier } from "../auth.ts";
import type { Database } from "../db.ts";
import { ApiFailure } from "../http.ts";
import { limit, type RateLimiter } from "../limits.ts";
import type { ClerkBackend } from "./clerk.ts";
import { deleteInClerk, markDeleted } from "./deletion.ts";

/** How recently the person must have proved their first factor to delete their account. */
const REVERIFY_MINUTES = 10;

export function accountRoutes(
  { db }: Database,
  verifier: Verifier,
  limiter: RateLimiter,
  clerk: ClerkBackend | null,
) {
  return new Hono<AuthEnv>()
    .use(requireIdentity(verifier, db, { allowDeleted: true }))
    .delete(
      "/",
      limit<AuthEnv>(
        limiter,
        "delete-account",
        10,
        (c) => c.get("identity").userId,
      ),
      async (c) => {
        const identity = c.get("identity");
        if (identity.via !== "session")
          throw new ApiFailure(
            403,
            "forbidden",
            "Delete the account in the phone app or at app.sikemux.com.",
          );
        if (
          identity.factorAgeMinutes === undefined ||
          identity.factorAgeMinutes > REVERIFY_MINUTES
        )
          throw new ApiFailure(403, "reverify_required", "reverify");

        const deletion = await markDeleted(db, {
          userId: identity.userId,
          actor: `user:${identity.userId}`,
          via: identity.origin ? "web" : "phone",
          deletedInClerk: false,
        });
        const log = c.get("log");
        log.info({ at: deletion.requestedAt }, "deleted an account");
        const deleted =
          deletion.deletedInClerk ||
          (await deleteInClerk(db, clerk, log, identity.userId));
        const body: AccountDeletion = {
          status: deleted ? "deleted" : "deleting",
          requestedAt: deletion.requestedAt.toISOString(),
        };
        return c.json(body, 202);
      },
    );
}
