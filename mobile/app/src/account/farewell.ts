import { useSyncExternalStore } from 'react';
import type { RevokeReason } from '@protocol';

/** Why this phone was signed out without being asked to: removed from the account, or the account deleted. */
export type Farewell = 'removed' | 'deleted';

let shown: Farewell | null = null;
const listeners = new Set<() => void>();

export function sayFarewell(farewell: Farewell | null) {
  shown = farewell;
  listeners.forEach((listener) => listener());
}

/** Signing out on this phone needs no explanation; anything else does. */
export function farewellFor(reason: RevokeReason): Farewell | null {
  if (reason === 'removed') return 'removed';
  if (reason === 'account_deleted') return 'deleted';
  return null;
}

export function useFarewell(): Farewell | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown,
  );
}
