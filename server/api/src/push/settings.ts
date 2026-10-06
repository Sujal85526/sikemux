import type { KeyObject } from "node:crypto";

import type { PushApp } from "@sikemux/protocol";

import { APNS_TOPICS, readApnsKey, type ApnsKey } from "./apns.ts";
import { readServiceAccount, type ServiceAccount } from "./fcm.ts";

export interface PushSettings {
  /** The one phone app whose tokens this server accepts and whose credentials it holds. */
  app: PushApp;
  /** Whether a production server accepts iOS tokens from Apple's sandbox, for builds run from Xcode. */
  allowSandbox: boolean;
  /** The Firebase service account FCM sends as, or null when Android pushes are not set up. */
  fcm: ServiceAccount | null;
  /** The key APNs takes this server's pushes with, or null when iPhone pushes are not set up. */
  apns: (ApnsKey & { topic: string }) | null;
}

const APPS: readonly PushApp[] = ["production", "dev"];

/** Apple's key and team ids are ten capital letters and digits. */
const APPLE_ID = /^[A-Z0-9]{10}$/;

/**
 * Reads PUSH_APP ("production" by default), APNS_ALLOW_SANDBOX ("1" to allow),
 * FCM_SERVICE_ACCOUNT_FILE, the path of the Firebase service account's JSON key, and
 * APNS_KEY_FILE, the path of Apple's .p8 push key, with its APNS_KEY_ID and APNS_TEAM_ID.
 */
export function readPush(
  env: NodeJS.ProcessEnv,
  problems: string[],
): PushSettings {
  const app = (env.PUSH_APP?.trim() || "production") as PushApp;
  if (!APPS.includes(app))
    problems.push(`PUSH_APP is not one of ${APPS.join(", ")}`);

  const sandbox = env.APNS_ALLOW_SANDBOX?.trim() || "0";
  if (sandbox !== "0" && sandbox !== "1")
    problems.push("APNS_ALLOW_SANDBOX is not 0 or 1");

  const path = env.FCM_SERVICE_ACCOUNT_FILE?.trim();
  let fcm: ServiceAccount | null = null;
  if (path) {
    try {
      fcm = readServiceAccount(path);
    } catch (error) {
      problems.push(
        `FCM_SERVICE_ACCOUNT_FILE ${path} ${(error as Error).message}`,
      );
    }
  }

  return {
    app,
    allowSandbox: app === "dev" || sandbox === "1",
    fcm,
    apns: readApns(env, app, problems),
  };
}

function readApns(
  env: NodeJS.ProcessEnv,
  app: PushApp,
  problems: string[],
): PushSettings["apns"] {
  const path = env.APNS_KEY_FILE?.trim();
  if (!path) return null;
  const keyId = env.APNS_KEY_ID?.trim() ?? "";
  const teamId = env.APNS_TEAM_ID?.trim() ?? "";
  const before = problems.length;
  if (!APPLE_ID.test(keyId))
    problems.push("APNS_KEY_ID is not a key id like ABC123DEFG");
  if (!APPLE_ID.test(teamId))
    problems.push("APNS_TEAM_ID is not a team id like D577WD6Z5U");
  let privateKey: KeyObject | undefined;
  try {
    privateKey = readApnsKey(path);
  } catch (error) {
    problems.push(`APNS_KEY_FILE ${path} ${(error as Error).message}`);
  }
  if (!privateKey || problems.length > before) return null;
  return { keyId, teamId, privateKey, topic: APNS_TOPICS[app] };
}
