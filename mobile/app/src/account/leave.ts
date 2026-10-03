import { router } from 'expo-router';

import { forget } from '@/devices/hub';
import { pairedDevices } from '@/devices/paired';
import { sayFarewell, type Farewell } from './farewell';
import { forgetCursor, stopLive } from './live';

let leaving: Promise<void> | undefined;

/**
 * The phone's half of leaving the account: forgets every paired host, asking each one it can reach to
 * unpair it, then signs out of Clerk. Two callers at once share one run.
 */
export function signOutHere(signOut: () => Promise<unknown>, farewell: Farewell | null = null): Promise<void> {
  if (farewell) sayFarewell(farewell);
  leaving ??= (async () => {
    stopLive();
    const devices = await pairedDevices().catch(() => []);
    await Promise.allSettled(devices.map((device) => forget(device.core)));
    await forgetCursor().catch(() => {});
    await signOut().catch((error: unknown) => console.warn('sikemux: Clerk could not sign out', error));
    router.replace('/');
  })().finally(() => {
    leaving = undefined;
  });
  return leaving;
}
