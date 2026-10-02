import * as SecureStore from 'expo-secure-store';

import type { BuildChannel } from '@/core/protocol';
import type { DeviceKind } from '@/ui/Icon';

export type Access = 'full' | 'watch';

/** A computer this phone paired with, known by its core's key. */
export type PairedDevice = {
  core: string;
  access: Access;
  pairedAt: number;
  name?: string;
  model?: string;
  channel?: BuildChannel;
  /** The project the device screen is scoped to; absent shows them all. */
  project?: string;
  /** The Mac's theme colours as last seen, so its screens open in them before it connects. */
  palette?: Record<string, string>;
  /** The Mac's pane backdrop as last seen, its picture saved on the phone. */
  backdrop?: { texture: boolean; image?: { id: string; uri: string } };
  lastSeen?: number;
};

const DEVICES_ITEM = 'sikemux.paired-devices';

export async function pairedDevices(): Promise<PairedDevice[]> {
  const stored = await SecureStore.getItemAsync(DEVICES_ITEM);
  return stored ? (JSON.parse(stored) as PairedDevice[]) : [];
}

async function save(devices: PairedDevice[]) {
  await SecureStore.setItemAsync(DEVICES_ITEM, JSON.stringify(devices));
}

export async function rememberDevice(device: PairedDevice): Promise<void> {
  const others = (await pairedDevices()).filter((known) => known.core !== device.core);
  await save([...others, device]);
}

export async function updateDevice(core: string, change: Partial<PairedDevice>): Promise<void> {
  const devices = await pairedDevices();
  await save(devices.map((device) => (device.core === core ? { ...device, ...change } : device)));
}

export async function forgetDevice(core: string): Promise<void> {
  await save((await pairedDevices()).filter((known) => known.core !== core));
}

export function shortKey(key: string): string {
  return key.slice(0, 8);
}

export function deviceName(device: Pick<PairedDevice, 'name' | 'core'>): string {
  return device.name ?? `Mac ${shortKey(device.core)}`;
}

/** Builds other than the stable release are named, since one Mac pairs once per channel. */
export function channelLabel(channel: BuildChannel | undefined): string | null {
  if (channel === 'dev') return 'Dev';
  if (channel === 'nightly') return 'Nightly';
  return null;
}

export function deviceKind(model: string | undefined): DeviceKind {
  if (!model) return 'laptop';
  if (/macbook/i.test(model)) return 'laptop';
  if (/mini/i.test(model)) return 'mini';
  return 'desktop';
}
