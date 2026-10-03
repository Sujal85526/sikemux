import { useEffect, useEffectEvent, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '@clerk/expo';
import * as Notifications from 'expo-notifications';

import { notifier } from '../../modules/notify';
import type { TokenSource } from '@/account/api';
import { openConnections, shareKeys } from '@/devices/hub';
import { withdrawKey } from './keys';
import { choose } from './setting';
import { notificationsAllowed, stopPush, syncPushToken } from './token';

/** Whether this phone can have notifications at all: Android only until iOS has Apple's push service. */
export const notificationsSupported = notifier !== null;

/** Turns notifications on, asking the system first; answers whether the system allows them. */
export async function turnOn(token: TokenSource): Promise<boolean> {
  await choose('on');
  const allowed = (await Notifications.requestPermissionsAsync()).granted;
  if (!allowed) return false;
  await syncPushToken(token).catch((error: unknown) => console.warn('sikemux: could not register for notifications', error));
  shareKeys();
  return true;
}

/** Turns notifications off: every connected host stops, the cards and keys go, and the server forgets the token. */
export async function turnOff(token: TokenSource) {
  await choose('off');
  await Promise.all(openConnections().map(([core, connection]) => withdrawKey(core, connection)));
  notifier?.removeAll();
  await stopPush(token).catch((error: unknown) => console.warn('sikemux: could not take back the notification token', error));
}

/** Whether the system lets the app notify, checked again whenever the app comes back to the front. */
export function useNotificationsAllowed(): boolean | undefined {
  const [allowed, setAllowed] = useState<boolean>();
  useEffect(() => {
    const check = () => {
      notificationsAllowed()
        .then(setAllowed)
        .catch(() => {});
    };
    check();
    const following = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => following.remove();
  }, []);
  return allowed;
}

/** Keeps the server's copy of the token current while signed in: on return to the app, and when the system issues a new one. */
export function usePushToken() {
  const { isSignedIn, getToken } = useAuth();
  const sync = useEffectEvent(() => {
    syncPushToken(() => getToken()).catch((error: unknown) => console.warn('sikemux: could not register for notifications', error));
  });
  useEffect(() => {
    if (!isSignedIn || !notificationsSupported) return;
    const following = AppState.addEventListener('change', (state) => {
      if (state === 'active') sync();
    });
    const renewed = Notifications.addPushTokenListener(() => sync());
    return () => {
      following.remove();
      renewed.remove();
    };
  }, [isSignedIn]);
}
