import { Platform } from 'react-native';
import type { ApiError, Challenge, Device, DeviceList, DeviceRegistration } from '@protocol';

import { thisDevice } from '@/device/identity';
import { phoneName } from '@/devices/pairing';
import { apiUrl } from './config';

export type TokenSource = () => Promise<string | null>;

export class AccountProblem extends Error {}

async function call<T>(token: TokenSource, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const bearer = await token();
  if (!bearer) throw new AccountProblem('Sign in again.');
  const response = await fetch(`${apiUrl()}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (response.status === 204) return null as T;
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as ApiError | null;
    throw new AccountProblem(failure?.error.message ?? `The accounts server answered ${response.status}.`);
  }
  return (await response.json()) as T;
}

/** Adds this phone to the account, proving it holds its key. Doing it again only updates its name. */
export async function registerPhone(token: TokenSource, userId: string): Promise<Device> {
  const challenge = await call<Challenge>(token, '/v1/devices/challenge', { method: 'POST' });
  const device = await thisDevice();
  const registration: DeviceRegistration = {
    key: device.id(),
    role: 'client',
    name: phoneName().slice(0, 64),
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    nonce: challenge.nonce,
    signature: device.signRegistration(challenge.nonce, userId),
  };
  return call<Device>(token, '/v1/devices', { method: 'POST', body: registration });
}

/** Takes this phone off the account, as signing out does. */
export async function removePhone(token: TokenSource): Promise<void> {
  const device = await thisDevice();
  await call<null>(token, `/v1/devices/${device.id()}`, { method: 'DELETE' });
}

/** The hosts signed in to the account. */
export async function accountHosts(token: TokenSource): Promise<Device[]> {
  return (await call<DeviceList>(token, '/v1/devices?role=host')).devices;
}
