import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountMacs, AccountProblem, registerPhone } from './api';
import { errorCode, explain } from './clerkErrors';

const identity = vi.hoisted(() => ({
  thisDevice: vi.fn(async () => ({
    id: () => 'ab'.repeat(32),
    signRegistration: vi.fn((nonce: string, userId: string) => `signed:${nonce}:${userId}`),
  })),
}));
vi.mock('@/device/identity', () => identity);
vi.mock('@/devices/pairing', () => ({ phoneName: () => 'Pixel 9' }));
vi.mock('./config', () => ({ apiUrl: () => 'https://api.test' }));

type Call = { url: string; method: string; body?: unknown; authorization?: string };
let calls: Call[];
let answers: { status: number; body: unknown }[];

beforeEach(() => {
  calls = [];
  answers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({
        url,
        method: init.method,
        authorization: init.headers.authorization,
        ...(init.body ? { body: JSON.parse(init.body) } : {}),
      });
      const answer = answers.shift() ?? { status: 500, body: {} };
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const token = async () => 'session-token';

describe('registerPhone', () => {
  it('signs the challenge the server gave and registers this phone as a client', async () => {
    answers.push({ status: 200, body: { nonce: 'n'.repeat(64), expiresAt: '2026-10-03T10:02:00.000Z' } });
    answers.push({ status: 201, body: { key: 'ab'.repeat(32), role: 'client' } });
    await registerPhone(token, 'user_2abc');
    expect(calls[0]).toMatchObject({ url: 'https://api.test/v1/devices/challenge', method: 'POST', authorization: 'Bearer session-token' });
    expect(calls[1]).toMatchObject({
      url: 'https://api.test/v1/devices',
      method: 'POST',
      body: {
        key: 'ab'.repeat(32),
        role: 'client',
        name: 'Pixel 9',
        nonce: 'n'.repeat(64),
        signature: `signed:${'n'.repeat(64)}:user_2abc`,
      },
    });
    expect(calls[1]?.body).not.toHaveProperty('channel');
  });

  it('passes on what the server said when it refuses', async () => {
    answers.push({ status: 200, body: { nonce: 'n'.repeat(64), expiresAt: '' } });
    answers.push({
      status: 409,
      body: { error: { code: 'conflict', message: 'This device is registered to another account.', requestId: 'r' } },
    });
    await expect(registerPhone(token, 'user_2abc')).rejects.toThrow('This device is registered to another account.');
  });

  it('asks to sign in again without a token', async () => {
    await expect(registerPhone(async () => null, 'user_2abc')).rejects.toBeInstanceOf(AccountProblem);
    expect(calls).toEqual([]);
  });
});

describe('accountMacs', () => {
  it('lists the hosts on the account', async () => {
    answers.push({ status: 200, body: { devices: [{ key: 'cd'.repeat(32), role: 'host', name: 'Studio' }] } });
    const macs = await accountMacs(token);
    expect(calls[0]?.url).toBe('https://api.test/v1/devices?role=host');
    expect(macs.map((mac) => mac.name)).toEqual(['Studio']);
  });
});

describe('Clerk errors', () => {
  it('reads the code and the words from either shape Clerk reports', () => {
    const listed = { errors: [{ code: 'form_identifier_not_found', longMessage: "Couldn't find your account." }] };
    expect(errorCode(listed)).toBe('form_identifier_not_found');
    expect(explain(listed)).toBe("Couldn't find your account.");
    expect(errorCode({ code: 'form_password_incorrect', message: 'Password is incorrect.' })).toBe('form_password_incorrect');
    expect(explain(undefined)).toBe('Something went wrong; try again.');
  });
});
