import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { useAuth } from '@clerk/expo';
import { nativeApplicationVersion } from 'expo-application';
import type { Device } from '@protocol';

import { thisDevice } from '@/device/identity';
import { syncPushToken } from '@/notify/token';
import { accountHosts, registerPhone } from './api';
import { apiUrl } from './config';
import { farewellFor } from './farewell';
import { signOutHere } from './leave';
import { LiveAccount, liveUrl, runLive, savedCursor } from './live';

/**
 * Registers this phone with the account once per sign-in, then its notification token, which the server
 * takes only from a phone on the account. A failure tries again on the next launch.
 */
export function useRegisterPhone() {
  const { isSignedIn, userId, getToken } = useAuth();
  const register = useEffectEvent((user: string) => {
    registerPhone(() => getToken(), user)
      .then(() => syncPushToken(() => getToken()))
      .catch((error: unknown) => {
        console.warn('sikemux: could not add this phone to the account', error);
      });
  });
  useEffect(() => {
    if (isSignedIn && userId) register(userId);
  }, [isSignedIn, userId]);
}

let hostsVersion = 0;
const hostsListeners = new Set<() => void>();

function hostsChanged() {
  hostsVersion += 1;
  hostsListeners.forEach((listener) => listener());
}

function subscribeHosts(listener: () => void) {
  hostsListeners.add(listener);
  return () => hostsListeners.delete(listener);
}

/** The hosts on the account; `loaded` once the server has answered since signing in. */
export type AccountHosts = { hosts: Device[]; loaded: boolean };

const NO_HOSTS: AccountHosts = { hosts: [], loaded: false };
let accountHostsNow = NO_HOSTS;

function publishHosts(next: AccountHosts) {
  accountHostsNow = next;
  hostsListeners.forEach((listener) => listener());
}

/** Reads the hosts on the account on signing in, and again whenever the live connection hears one change. */
export function useAccountHostsFeed() {
  const { isSignedIn, getToken } = useAuth();
  const version = useSyncExternalStore(subscribeHosts, () => hostsVersion);
  const latestGetToken = useRef(getToken);
  useEffect(() => {
    latestGetToken.current = getToken;
  });
  useEffect(() => {
    if (!isSignedIn) {
      publishHosts(NO_HOSTS);
      return;
    }
    let current = true;
    accountHosts(() => latestGetToken.current())
      .then((hosts) => current && publishHosts({ hosts, loaded: true }))
      .catch((error: unknown) => console.warn('sikemux: could not list the hosts on the account', error));
    return () => {
      current = false;
    };
  }, [isSignedIn, version]);
}

export function useAccountHosts(): AccountHosts {
  return useSyncExternalStore(subscribeHosts, () => accountHostsNow);
}

/** Keeps this phone connected to its account while the app is in front and signed in. */
export function useAccountLive() {
  const { isSignedIn, getToken, signOut } = useAuth();
  const token = useEffectEvent(() => getToken());
  const leave = useEffectEvent((farewell: ReturnType<typeof farewellFor>) => signOutHere(() => signOut(), farewell));
  useEffect(() => {
    if (!isSignedIn) return;
    const live = new LiveAccount({
      url: liveUrl(apiUrl()),
      connect: (url, on) => {
        const socket = new WebSocket(url);
        socket.onmessage = (event) => on.message(event.data);
        socket.onclose = (event) => on.closed(event.code);
        return socket;
      },
      key: async () => (await thisDevice()).id(),
      sign: async (nonce) => (await thisDevice()).signLive(nonce),
      token: () => token(),
      app: { platform: Platform.OS === 'ios' ? 'ios' : 'android', version: nativeApplicationVersion ?? 'unknown' },
      cursor: savedCursor,
      hostsChanged,
      gone: (reason) => void leave(farewellFor(reason)),
    });
    runLive(live);
    if (AppState.currentState === 'active') live.start();
    const following = AppState.addEventListener('change', (state) => {
      if (state === 'active') live.start();
      else if (state === 'background') live.stop();
    });
    return () => {
      following.remove();
      live.stop();
    };
  }, [isSignedIn]);
}
