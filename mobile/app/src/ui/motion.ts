import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

/** One system setting, followed once for the whole app however many components read it. */
function followed<T>(initial: T, follow: (set: (value: T) => void) => void) {
  let value = initial;
  let following = false;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      if (!following) {
        following = true;
        follow((next) => {
          if (next === value) return;
          value = next;
          listeners.forEach((listen) => listen());
        });
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => value,
  };
}

const reduceMotion = followed(false, (set) => {
  AccessibilityInfo.isReduceMotionEnabled()
    .then(set)
    .catch(() => {});
  AccessibilityInfo.addEventListener('reduceMotionChanged', set);
});

const appActive = followed(AppState.currentState === 'active', (set) => {
  AppState.addEventListener('change', (state) => set(state === 'active'));
});

/** Whether the person asked the system to reduce motion. */
export function useStill(): boolean {
  return useSyncExternalStore(reduceMotion.subscribe, reduceMotion.get);
}

/** Whether the app is in front. */
export function useAppActive(): boolean {
  return useSyncExternalStore(appActive.subscribe, appActive.get);
}

let covers = 0;
const coverListeners = new Set<() => void>();

/** Marks the screen as hidden under a sheet until the returned function is called. */
export function coverScreen(): () => void {
  covers += 1;
  coverListeners.forEach((listen) => listen());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    covers -= 1;
    coverListeners.forEach((listen) => listen());
  };
}

function subscribeCovers(listener: () => void) {
  coverListeners.add(listener);
  return () => {
    coverListeners.delete(listener);
  };
}

/** Whether a sheet covers the screen. */
export function useCovered(): boolean {
  return useSyncExternalStore(subscribeCovers, () => covers > 0);
}
