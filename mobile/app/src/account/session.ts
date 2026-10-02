import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useAuth } from '@clerk/expo';
import { useFocusEffect } from 'expo-router';
import type { Device } from '@protocol';

import { accountMacs, registerPhone } from './api';

/** Registers this phone with the account once per sign-in; a failure tries again on the next launch. */
export function useRegisterPhone() {
  const { isSignedIn, userId, getToken } = useAuth();
  const register = useEffectEvent((user: string) => {
    registerPhone(() => getToken(), user).catch((error: unknown) => {
      console.warn('sikemux: could not add this phone to the account', error);
    });
  });
  useEffect(() => {
    if (isSignedIn && userId) register(userId);
  }, [isSignedIn, userId]);
}

/** The Macs on the account, read again whenever the screen comes back into view. */
export function useAccountMacs(): Device[] {
  const { isSignedIn, getToken } = useAuth();
  const [macs, setMacs] = useState<Device[]>([]);
  const latestGetToken = useRef(getToken);
  useEffect(() => {
    latestGetToken.current = getToken;
  });
  useFocusEffect(
    useCallback(() => {
      if (!isSignedIn) return;
      let live = true;
      accountMacs(() => latestGetToken.current())
        .then((found) => live && setMacs(found))
        .catch((error: unknown) => console.warn('sikemux: could not list the Macs on the account', error));
      return () => {
        live = false;
      };
    }, [isSignedIn]),
  );
  return macs;
}
