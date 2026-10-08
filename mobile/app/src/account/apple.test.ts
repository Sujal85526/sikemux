import { afterEach, describe, expect, it, vi } from 'vitest';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';

import { appleConsent } from './apple';

const apple = [{ provider: 'google' }, { provider: 'apple' }];

afterEach(() => {
  Platform.OS = 'ios';
});

describe('appleConsent', () => {
  it("asks Apple's sheet for a fresh code when the account signs in with Apple", async () => {
    const signIn = vi.spyOn(AppleAuthentication, 'signInAsync');
    expect(await appleConsent(apple)).toEqual({ cancelled: false, code: 'apple-code' });
    expect(signIn).toHaveBeenCalledWith({ requestedScopes: [] });
  });

  it('asks nothing of an account without Apple, or on Android', async () => {
    const signIn = vi.spyOn(AppleAuthentication, 'signInAsync');
    expect(await appleConsent([{ provider: 'google' }])).toEqual({ cancelled: false });
    expect(await appleConsent(undefined)).toEqual({ cancelled: false });
    Platform.OS = 'android';
    expect(await appleConsent(apple)).toEqual({ cancelled: false });
    expect(signIn).not.toHaveBeenCalled();
  });

  it('cancels the deletion when the person closes the sheet', async () => {
    vi.spyOn(AppleAuthentication, 'signInAsync').mockRejectedValue(
      Object.assign(new Error('The user canceled the authorization attempt'), { code: 'ERR_REQUEST_CANCELED' }),
    );
    expect(await appleConsent(apple)).toEqual({ cancelled: true });
  });

  it("goes on without a code when Apple can't give one", async () => {
    vi.spyOn(AppleAuthentication, 'signInAsync').mockRejectedValue(Object.assign(new Error('failed'), { code: 'ERR_REQUEST_FAILED' }));
    expect(await appleConsent(apple)).toEqual({ cancelled: false });
    vi.spyOn(AppleAuthentication, 'signInAsync').mockResolvedValue({ authorizationCode: null } as never);
    expect(await appleConsent(apple)).toEqual({ cancelled: false, code: undefined });
    vi.spyOn(AppleAuthentication, 'isAvailableAsync').mockResolvedValue(false);
    expect(await appleConsent(apple)).toEqual({ cancelled: false });
  });
});
