import { describe, expect, it } from 'vitest';

import { versionLabel } from '@/account/versionLabel';

describe('versionLabel', () => {
  it('is only the version when the app runs the code it was installed with', () => {
    expect(versionLabel('0.1.0', { id: 'A1B2C3D4-0000-4000-8000-000000000000', createdAt: new Date(), embedded: true })).toBe('0.1.0');
  });

  it('names the update and the day it was made when one is running', () => {
    const update = { id: 'A1B2C3D4-0000-4000-8000-000000000000', createdAt: new Date(2026, 9, 3, 14, 30), embedded: false };
    expect(versionLabel('0.1.0', update)).toBe('0.1.0 · update a1b2c3d (3 Oct)');
  });

  it('leaves out a date it does not have', () => {
    expect(versionLabel('0.1.0', { id: 'a1b2c3d4-0000', createdAt: null, embedded: false })).toBe('0.1.0 · update a1b2c3d');
  });

  it('is only the version when updates are off', () => {
    expect(versionLabel('0.1.0', { id: null, createdAt: null, embedded: false })).toBe('0.1.0');
  });
});
