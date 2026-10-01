import * as SecureStore from 'expo-secure-store';
import { Device, newDeviceKey, type DeviceLike } from '@sikemux/native';

const KEY_ITEM = 'sikemux.device-key';

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytes(text: string): ArrayBuffer {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

/** This phone's key, made once and kept in the Keychain or Keystore. */
async function deviceKey(): Promise<ArrayBuffer> {
  const stored = await SecureStore.getItemAsync(KEY_ITEM);
  if (stored) return bytes(stored);
  const key = newDeviceKey();
  await SecureStore.setItemAsync(KEY_ITEM, hex(key));
  return key;
}

let online: Promise<DeviceLike> | undefined;

/** This phone on the network, brought online once per launch. */
export function thisDevice(): Promise<DeviceLike> {
  online ??= deviceKey().then((key) => Device.create(key));
  return online;
}
