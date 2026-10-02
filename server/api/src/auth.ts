import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { MiddlewareHandler } from "hono";

import { ApiFailure, type Env } from "./http.ts";

export interface Identity {
  userId: string;
  /** "session" for Clerk session tokens from the phone and the web app, "mac" for the Mac app's OAuth tokens. */
  via: "session" | "mac";
}

export interface Verifier {
  verify(token: string): Promise<Identity>;
}

export interface VerifierOptions {
  issuer: string;
  macClientId: string;
  /** Browser origins a session token may come from. Native apps send none. */
  authorizedParties: string[];
  keys?: JWTVerifyGetKey;
}

const OAUTH_TYPES = new Set(["at+jwt", "application/at+jwt"]);

function unauthorized(message: string): ApiFailure {
  return new ApiFailure(401, "unauthorized", message);
}

/**
 * Checks Clerk's tokens against the instance's public keys, without calling Clerk. Session
 * tokens come from the phone and the web app; OAuth access tokens come only from the Mac app.
 */
export function clerkVerifier(options: VerifierOptions): Verifier {
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL("/.well-known/jwks.json", options.issuer));
  return {
    async verify(token) {
      let verified;
      try {
        verified = await jwtVerify(token, keys, {
          issuer: options.issuer,
          algorithms: ["RS256"],
          clockTolerance: 5,
        });
      } catch (error) {
        if (error instanceof errors.JWTExpired)
          throw unauthorized("The sign-in token has expired.");
        if (error instanceof errors.JOSEError)
          throw unauthorized("The sign-in token is not valid.");
        throw error;
      }
      const { payload, protectedHeader } = verified;
      if (typeof payload.sub !== "string" || !payload.sub.startsWith("user_")) {
        throw unauthorized("The sign-in token is not for a user.");
      }
      if (OAUTH_TYPES.has(protectedHeader.typ ?? "")) {
        if (payload.client_id !== options.macClientId) {
          throw unauthorized("The sign-in token was issued to another app.");
        }
        return { userId: payload.sub, via: "mac" };
      }
      if (typeof payload.sid !== "string")
        throw unauthorized("The sign-in token is not a session token.");
      if (payload.sts === "pending")
        throw unauthorized("The sign-in is not finished.");
      if (
        typeof payload.azp === "string" &&
        !options.authorizedParties.includes(payload.azp)
      ) {
        throw unauthorized("The sign-in token was issued to another site.");
      }
      return { userId: payload.sub, via: "session" };
    },
  };
}

export type AuthEnv = Env & { Variables: { identity: Identity } };

/** Requires `Authorization: Bearer <token>` and puts who signed in on the context. */
export function requireIdentity(
  verifier: Verifier,
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1])
      throw unauthorized("Sign in first: send Authorization: Bearer <token>.");
    const identity = await verifier.verify(match[1]);
    c.set("identity", identity);
    c.set("log", c.get("log").child({ userId: identity.userId }));
    await next();
  };
}
