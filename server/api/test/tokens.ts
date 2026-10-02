import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";

import { clerkVerifier } from "../src/auth.ts";

export const ISSUER = "https://clerk.sikemux.test";
export const MAC_CLIENT_ID = "mac_client";
export const APP_ORIGIN = "https://app.sikemux.test";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk: JWK = {
  ...(await exportJWK(publicKey)),
  kid: "test-key",
  alg: "RS256",
};
const keys = createLocalJWKSet({ keys: [jwk] });

export const verifier = clerkVerifier({
  issuer: ISSUER,
  macClientId: MAC_CLIENT_ID,
  authorizedParties: [APP_ORIGIN],
  keys,
});

interface Mint {
  typ?: string;
  issuer?: string;
  expiresIn?: string;
  claims?: Record<string, unknown>;
  key?: CryptoKey;
}

async function mint(
  userId: string,
  {
    typ = "JWT",
    issuer = ISSUER,
    expiresIn = "1m",
    claims = {},
    key = privateKey,
  }: Mint,
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key", typ })
    .setIssuer(issuer)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/** A Clerk session token, as the phone and the web app send. */
export function sessionToken(userId: string, options: Mint = {}) {
  return mint(userId, {
    ...options,
    claims: { sid: "sess_test", ...options.claims },
  });
}

/** A Clerk OAuth access token, as the Mac app sends. */
export function macToken(userId: string, options: Mint = {}) {
  return mint(userId, {
    typ: "at+jwt",
    ...options,
    claims: {
      client_id: MAC_CLIENT_ID,
      scope: "email profile",
      ...options.claims,
    },
  });
}

export async function otherSigningKey() {
  return (await generateKeyPair("RS256")).privateKey;
}
