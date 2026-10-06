import * as SecureStore from 'expo-secure-store';

import { goOffline } from './identity';

/** The item identity.ts keeps this phone's key under; it makes a new key when the item is gone. */
const KEY_ITEM = 'sikemux.device-key';
const KEY_OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/**
 * Makes this phone a new device: the account may still hold the old key, and anything it signed for
 * that account must not follow the phone into another one.
 */
export async function rotateDeviceKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_ITEM, KEY_OPTIONS);
  await goOffline();
}
