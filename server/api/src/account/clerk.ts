/** The two calls the API makes to Clerk's Backend API. Both count "already gone" as done. */
export interface ClerkBackend {
  deleteUser(userId: string): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
}

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const BASE = "https://api.clerk.com";
const TIMEOUT_MS = 10_000;

export function clerkBackend(
  secretKey: string,
  fetcher: Fetch = fetch,
): ClerkBackend {
  const call = async (method: string, path: string) => {
    const response = await fetcher(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok || response.status === 404) return;
    throw new Error(`Clerk answered ${response.status} to ${method} ${path}`);
  };
  const checked = (id: string, prefix: string) => {
    if (!new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id))
      throw new Error(`${JSON.stringify(id)} is not a Clerk ${prefix} id`);
    return id;
  };
  return {
    deleteUser: async (userId) =>
      call("DELETE", `/v1/users/${checked(userId, "user")}`),
    revokeSession: async (sessionId) =>
      call("POST", `/v1/sessions/${checked(sessionId, "sess")}/revoke`),
  };
}
