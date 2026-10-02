import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@clerk/expo';
import { useFocusEffect } from 'expo-router';
import type { Device } from '@protocol';

import { accountMacs, registerPhone } from './api';

/** Registers this phone with the account once per sign-in; a failure tries again on the next launch. */
export function useRegisterPhone() {
  const { isSignedIn, userId, getToken } = useAuth();
  useEffect(() => {
    if (!isSignedIn || !userId) return;
    registerPhone(() => getToken(), userId).catch((error: unknown) => {
      console.warn('sikemux: could not add this phone to the account', error);
    });
  }, [isSignedIn, userId, getToken]);
}

/** The Macs on the account, read again whenever the screen comes back into view. */
export function useAccountMacs(): Device[] {
  const { isSignedIn, getToken } = useAuth();
  const [macs, setMacs] = useState<Device[]>([]);
  useFocusEffect(
    useCallback(() => {
      if (!isSignedIn) return;
      let live = true;
      accountMacs(() => getToken())
        .then((found) => live && setMacs(found))
        .catch((error: unknown) => console.warn('sikemux: could not list the Macs on the account', error));
      return () => {
        live = false;
      };
    }, [isSignedIn, getToken]),
  );
  return macs;
}
