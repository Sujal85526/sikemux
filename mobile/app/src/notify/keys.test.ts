import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionLike } from '@sikemux/native';

import { DEFAULT_PREFS, hostKey, shareKey } from './keys';
import { choose } from './setting';

const native = vi.hoisted(() => {
  const keys = new Map<string, { keyId: number; key: string }>();
  return {
    keys,
    notifier: {
      key: (host: string) => keys.get(host) ?? null,
      setKey: (host: string, keyId: number, key: string) => void keys.set(host, { keyId, key }),
      removeKey: (host: string) => void keys.delete(host),
    },
  };
});
vi.mock('../../modules/notify', () => native);

const HOST = 'ea'.repeat(32);

function connection(setNotifications: () => Promise<void>) {
  return { setNotifications: vi.fn(setNotifications) } as unknown as ConnectionLike & { setNotifications: ReturnType<typeof vi.fn> };
}

beforeEach(async () => {
  native.keys.clear();
  await choose('on');
});

describe('hostKey', () => {
  it('makes a 32-byte key with a 32-bit id once, then keeps giving the same one', () => {
    const made = hostKey(HOST);
    expect(made?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(made?.keyId).toBeGreaterThanOrEqual(0);
    expect(made?.keyId).toBeLessThan(2 ** 32);
    expect(hostKey(HOST)).toEqual(made);
  });
});

describe('shareKey', () => {
  it('gives the host its key and the default preferences', async () => {
    const open = connection(async () => {});
    expect(await shareKey(HOST, open)).toBe('shared');
    const [keyId, key, prefs] = open.setNotifications.mock.calls[0];
    expect(keyId).toBe(native.keys.get(HOST)?.keyId);
    const sent = Array.from(new Uint8Array(key as ArrayBuffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(sent).toBe(native.keys.get(HOST)?.key);
    expect(JSON.parse(prefs as string)).toEqual(DEFAULT_PREFS);
  });

  it('gives nothing while notifications are off', async () => {
    await choose('off');
    const open = connection(async () => {});
    expect(await shareKey(HOST, open)).toBe('off');
    expect(open.setNotifications).not.toHaveBeenCalled();
  });

  it('takes a host that never answers for one too old to notify', async () => {
    vi.useFakeTimers();
    const sharing = shareKey(
      HOST,
      connection(() => new Promise(() => {})),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await sharing).toBe('host-too-old');
    vi.useRealTimers();
  });
});
