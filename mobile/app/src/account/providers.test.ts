import { describe, expect, it } from 'vitest';

import { providerName } from './providers';

describe('the provider an account signs in with', () => {
  it('reads the names Clerk gives in the words the sign-in buttons use', () => {
    expect(providerName('oauth_google')).toBe('Google');
    expect(providerName('github')).toBe('GitHub');
    expect(providerName('oauth_apple')).toBe('apple');
    expect(providerName(undefined)).toBeUndefined();
  });
});
