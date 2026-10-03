import type { PushApp } from "@sikemux/protocol";

import { readServiceAccount, type ServiceAccount } from "./fcm.ts";

export interface PushSettings {
  /** The one phone app whose tokens this server accepts and whose credentials it holds. */
  app: PushApp;
  /** Whether a production server accepts iOS tokens from Apple's sandbox, for builds run from Xcode. */
  allowSandbox: boolean;
  /** The Firebase service account FCM sends as, or null when Android pushes are not set up. */
  fcm: ServiceAccount | null;
}

const APPS: readonly PushApp[] = ["production", "dev"];

/**
 * Reads PUSH_APP ("production" by default), APNS_ALLOW_SANDBOX ("1" to allow) and
 * FCM_SERVICE_ACCOUNT_FILE, the path of the Firebase service account's JSON key.
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

  return { app, allowSandbox: app === "dev" || sandbox === "1", fcm };
}
