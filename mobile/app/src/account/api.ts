import { Platform } from 'react-native';
import type {
  AccountDeletion,
  ApiError,
  Challenge,
  Device,
  DeviceList,
  DeviceRegistration,
  JoinRequest,
  JoinTicket,
  PushApp,
  PushTokenRegistration,
  PushTokenState,
} from '@protocol';

import { thisDevice } from '@/device/identity';
import { phoneName } from '@/device/name';
import { apiUrl } from './config';

export type TokenSource = () => Promise<string | null>;

export class AccountProblem extends Error {
  /** The server's status, or undefined when it could not be reached at all. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }

  /** Nothing changed on the server: it was out of reach, or failed on its side. */
  get unreachable(): boolean {
    return this.status === undefined || this.status >= 500;
  }
}

/** The server wants a recent proof of the person's password or email before it deletes the account. */
export class ReverifyNeeded extends Error {}

async function call<T>(token: TokenSource, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const bearer = await token();
  if (!bearer) throw new AccountProblem('Sign in again.', 401);
  let response: Response;
  try {
    response = await fetch(`${apiUrl()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new AccountProblem("Can't reach Sikemux. Check the phone is online.");
  }
  if (response.status === 204) return null as T;
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as ApiError | null;
    if (response.status === 403 && failure?.error?.message === 'reverify') throw new ReverifyNeeded('reverify');
    throw new AccountProblem(failure?.error?.message ?? `The accounts server answered ${response.status}.`, response.status);
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

/** Takes this phone off the account, as signing out does. A phone the account no longer has is already off it. */
export async function removePhone(token: TokenSource): Promise<void> {
  const device = await thisDevice();
  try {
    await call<null>(token, `/v1/devices/${device.id()}`, { method: 'DELETE' });
  } catch (error) {
    if (error instanceof AccountProblem && (error.status === 404 || error.status === 401)) return;
    throw error;
  }
}

/** Sends this phone's notifications to an FCM token, proving the phone holds its key. */
export async function setPushToken(
  token: TokenSource,
  push: { token: string; tokenSha256: string; app: PushApp },
): Promise<PushTokenState> {
  const challenge = await call<Challenge>(token, '/v1/devices/challenge', { method: 'POST' });
  const device = await thisDevice();
  const registration: PushTokenRegistration = {
    platform: 'fcm',
    token: push.token,
    app: push.app,
    nonce: challenge.nonce,
    signature: device.signPush(challenge.nonce, push.tokenSha256),
  };
  return call<PushTokenState>(token, `/v1/devices/${device.id()}/push`, { method: 'PUT', body: registration });
}

/** Stops the server sending this phone notifications. A phone the account no longer has gets none anyway. */
export async function clearPushToken(token: TokenSource): Promise<void> {
  const device = await thisDevice();
  try {
    await call<null>(token, `/v1/devices/${device.id()}/push`, { method: 'DELETE' });
  } catch (error) {
    if (error instanceof AccountProblem && (error.status === 404 || error.status === 401)) return;
    throw error;
  }
}

/** The hosts signed in to the account. */
export async function accountHosts(token: TokenSource): Promise<Device[]> {
  return (await call<DeviceList>(token, '/v1/devices?role=host')).devices;
}

/** The server's signed word that this phone and `host` are on the same account, for the host to check before it asks its owner. */
export async function joinTicket(token: TokenSource, host: string): Promise<JoinTicket> {
  const device = await thisDevice();
  const request: JoinRequest = { host };
  return call<JoinTicket>(token, `/v1/devices/${device.id()}/join`, { method: 'POST', body: request });
}

/** Deletes the account and every device on it. */
export async function deleteAccount(token: TokenSource): Promise<AccountDeletion> {
  return call<AccountDeletion>(token, '/v1/account', { method: 'DELETE' });
}
