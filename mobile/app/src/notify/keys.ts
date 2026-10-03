import * as Crypto from 'expo-crypto';
import type { ConnectionLike } from '@sikemux/native';

import { notifier } from '../../modules/notify';
import { notificationsChoice } from './setting';

/** What the phone asks every host for until it has its own settings screen. */
export const DEFAULT_PREFS = { needsYou: true, finished: true, problems: true, when: 'away', muted: [] } as const;

/** A host older than notifications never answers the request, so its silence means it needs an update. */
const ANSWER_MS = 10_000;

export type Shared = 'shared' | 'off' | 'host-too-old' | 'failed';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytes(text: string): ArrayBuffer {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

/** The key this phone gave `host`, or a new one when it has none or the host's last push would not open with it. */
export function hostKey(host: string): { keyId: number; key: string } | null {
  if (!notifier) return null;
  const kept = notifier.key(host);
  if (kept) return kept;
  const random = Crypto.getRandomBytes(36);
  const keyId = new DataView(random.buffer, random.byteOffset, 4).getUint32(0);
  const made = { keyId, key: hex(random.subarray(4)) };
  notifier.setKey(host, made.keyId, made.key);
  return made;
}

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((settle) => setTimeout(() => settle('timeout'), ms));
}

/** Gives a host this phone's notification key, on each connection, or tells it to stop when notifications are off. */
export async function shareKey(host: string, connection: ConnectionLike): Promise<Shared> {
  if (!notifier) return 'off';
  if ((await notificationsChoice()) !== 'on') return 'off';
  const key = hostKey(host);
  if (!key) return 'off';
  try {
    const answer = await Promise.race([
      connection.setNotifications(key.keyId, bytes(key.key), JSON.stringify(DEFAULT_PREFS)),
      timeout(ANSWER_MS),
    ]);
    return answer === 'timeout' ? 'host-too-old' : 'shared';
  } catch (error) {
    console.warn('sikemux: could not give the host the notification key', error);
    return 'failed';
  }
}

/** Asks a host to stop notifying this phone, and forgets the key it had. */
export async function withdrawKey(host: string, connection: ConnectionLike | undefined) {
  notifier?.removeKey(host);
  await connection?.clearNotifications().catch(() => {});
}
