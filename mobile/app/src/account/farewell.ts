import { useSyncExternalStore } from 'react';
import type { RevokeReason } from '@protocol';

/** Why this phone signed out: removed from the account, the account deleted elsewhere, or deleted here. */
export type Farewell = 'removed' | 'deleted' | 'deleted-here';

let shown: Farewell | null = null;
const listeners = new Set<() => void>();

export function sayFarewell(farewell: Farewell | null) {
  // The live connection also hears of a deletion made here, and may hear it last.
  if (shown === 'deleted-here' && farewell === 'deleted') return;
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
