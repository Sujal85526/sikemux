import type { ClerkBackend } from "../src/account/clerk.ts";

/** Clerk's Backend API as the tests want it to answer: done, or failing until told otherwise. */
export class FakeClerk implements ClerkBackend {
  readonly deleted: string[] = [];
  readonly revoked: string[] = [];
  failing = false;

  async deleteUser(userId: string) {
    if (this.failing) throw new Error("Clerk answered 500");
    this.deleted.push(userId);
  }

  async revokeSession(sessionId: string) {
    if (this.failing) throw new Error("Clerk answered 500");
    this.revoked.push(sessionId);
  }
}
