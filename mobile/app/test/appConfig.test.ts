import { afterEach, describe, expect, it, vi } from 'vitest';

import appConfig from '../app.config.js';
import { expo } from '../app.json';

function resolve(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return appConfig({ config: structuredClone(expo) });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('updates', () => {
  it('asks for nightly updates when no channel is given', () => {
    const config = resolve({ APP_VARIANT: 'production', SIKEMUX_MOBILE_CHANNEL: undefined });
    expect(config.updates.requestHeaders).toEqual({ 'expo-channel-name': 'nightly' });
    expect(config.updates.url).toBe('https://updates.sikemux.com/manifest');
    expect(config.updates.fallbackToCacheTimeout).toBe(0);
    expect(config.updates.codeSigningMetadata).toEqual({ keyid: 'main', alg: 'rsa-v1_5-sha256' });
    expect(config.runtimeVersion).toEqual({ policy: 'fingerprint' });
  });

  it('treats an empty channel as no channel', () => {
    const config = resolve({ APP_VARIANT: 'production', SIKEMUX_MOBILE_CHANNEL: '' });
    expect(config.updates.requestHeaders['expo-channel-name']).toBe('nightly');
  });

  it('asks for stable updates on a stable build', () => {
    const config = resolve({ APP_VARIANT: 'production', SIKEMUX_MOBILE_CHANNEL: 'stable' });
    expect(config.updates.requestHeaders['expo-channel-name']).toBe('stable');
  });

  it('refuses a channel that does not exist', () => {
    expect(() => resolve({ APP_VARIANT: 'production', SIKEMUX_MOBILE_CHANNEL: 'beta' })).toThrow('beta is not a release channel');
  });

  it('is off in dev builds, whatever the channel', () => {
    const config = resolve({ APP_VARIANT: undefined, SIKEMUX_MOBILE_CHANNEL: 'beta' });
    expect(config.updates).toEqual({ enabled: false });
    expect(config.runtimeVersion).toBeUndefined();
  });
});
