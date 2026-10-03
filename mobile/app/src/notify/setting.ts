import { useEffect, useSyncExternalStore } from 'react';
import * as SecureStore from 'expo-secure-store';

/** Whether the person wants notifications: undefined until they first choose. */
export type Choice = 'on' | 'off' | undefined;

const ITEM = 'sikemux.notifications';

let choice: Choice;
let loaded: Promise<Choice> | undefined;
let offered = false;
const listeners = new Set<() => void>();

function changed() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notificationsChoice(): Promise<Choice> {
  loaded ??= SecureStore.getItemAsync(ITEM).then((stored) => {
    choice = stored === 'on' || stored === 'off' ? stored : undefined;
    changed();
    return choice;
  });
  return loaded;
}

export async function choose(next: Choice) {
  choice = next;
  loaded = Promise.resolve(next);
  if (next) await SecureStore.setItemAsync(ITEM, next);
  else await SecureStore.deleteItemAsync(ITEM);
  changed();
}

export function useNotificationsChoice(): Choice {
  useEffect(() => {
    notificationsChoice().catch(() => {});
  }, []);
  return useSyncExternalStore(subscribe, () => choice);
}

/** Asks once, after a pairing, whether to turn notifications on; a person who already chose is not asked. */
export async function offerNotifications() {
  if ((await notificationsChoice()) !== undefined) return;
  offered = true;
  changed();
}

export function closeOffer() {
  offered = false;
  changed();
}

export function useOffered(): boolean {
  return useSyncExternalStore(subscribe, () => offered);
}
