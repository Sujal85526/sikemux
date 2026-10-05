import { describe, expect, it } from 'vitest';

import { versionLabel } from '@/account/versionLabel';

const ID = 'A1B2C3D4-0000-4000-8000-000000000000';

describe('versionLabel', () => {
  it('names the commit the installed app was built from', () => {
    expect(versionLabel('0.1.0-nightly.5', 'cef3bae', { id: ID, createdAt: new Date(), embedded: true })).toBe('0.1.0-nightly.5 · cef3bae');
  });

  it('names the update by its commit and the day it was made when one is running', () => {
    const update = { id: ID, createdAt: new Date(2026, 9, 6, 14, 30), embedded: false };
    expect(versionLabel('0.1.0-nightly.5', '1b46d28', update)).toBe('0.1.0-nightly.5 · update 1b46d28 (6 Oct)');
  });

  it('falls back to the update id when the update carries no commit', () => {
    expect(versionLabel('0.1.0', null, { id: 'a1b2c3d4-0000', createdAt: null, embedded: false })).toBe('0.1.0 · update a1b2c3d');
  });

  it('is only the version for a build that knows no commit', () => {
    expect(versionLabel('0.1.0', null, { id: null, createdAt: null, embedded: false })).toBe('0.1.0');
  });
});
