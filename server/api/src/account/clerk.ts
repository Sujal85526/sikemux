/** The calls the API makes to Clerk's Backend API. Each counts "already gone" as done. */
export interface ClerkBackend {
  deleteUser(userId: string): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
  /** The access tokens Clerk holds from the user's web sign-ins with Apple; none for the phone's. */
  appleAccessTokens(userId: string): Promise<string[]>;
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
  const request = async (method: string, path: string) => {
    const response = await fetcher(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new Error(`Clerk answered ${response.status} to ${method} ${path}`);
  };
  const call = async (method: string, path: string) => {
    const response = await request(method, path);
    await response?.body?.cancel();
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
    appleAccessTokens: async (userId) => {
      const response = await request(
        "GET",
        `/v1/users/${checked(userId, "user")}/oauth_access_tokens/oauth_apple`,
      );
      const listed: unknown = await response?.json();
      if (!Array.isArray(listed)) return [];
      return listed.flatMap((entry: { token?: unknown }) =>
        typeof entry?.token === "string" && entry.token ? [entry.token] : [],
      );
    },
  };
}
