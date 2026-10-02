import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { MobileError, type ConnectionLike } from '@sikemux/native';

import { host, snapshot, type Snapshot } from '@/core/protocol';
import { thisDevice } from '@/device/identity';
import { forgetDevice, pairedDevices, updateDevice, type PairedDevice } from './paired';

export type Live =
  | { status: 'connecting'; snapshot?: Snapshot }
  | { status: 'open'; connection: ConnectionLike; snapshot?: Snapshot }
  | { status: 'closed'; problem: string; outdated?: Outdated; snapshot?: Snapshot };

/** Which side needs a newer Sikemux before the two can talk. */
export type Outdated = 'mac' | 'phone';

/** Many events arrive together while an agent works; one refresh covers them. */
const REFRESH_AFTER_MS = 250;
/** The core announces no new terminals or chats, so the phone asks again this often. */
const POLL_MS = 5000;
/** A device nobody is looking at keeps its connection this long, for a quick return. */
const LINGER_MS = 30_000;
const RETRY_MS = [1000, 3000, 8000, 15_000];
/** A Mac that does not answer the unpair in this time is forgotten on the phone anyway. */
const UNPAIR_WAIT_MS = 3000;

type Entry = {
  live: Live;
  watchers: number;
  attempt: number;
  refreshing?: ReturnType<typeof setTimeout>;
  polling?: ReturnType<typeof setInterval>;
  retrying?: ReturnType<typeof setTimeout>;
  lingering?: ReturnType<typeof setTimeout>;
  events: Set<(json: string) => void>;
  output: Set<(session: bigint, bytes: ArrayBuffer) => void>;
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let devices: PairedDevice[] = [];
let devicesLoaded = false;

function changed() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function entry(core: string): Entry {
  let found = entries.get(core);
  if (!found) {
    found = { live: { status: 'connecting' }, watchers: 0, attempt: 0, events: new Set(), output: new Set() };
    entries.set(core, found);
  }
  return found;
}

function set(core: string, live: Live) {
  entry(core).live = live;
  changed();
}

function outdated(error: unknown): Outdated | undefined {
  if (!MobileError.Outdated.instanceOf(error)) return undefined;
  return error.inner.macIsOlder ? 'mac' : 'phone';
}

function problem(error: unknown): string {
  if (MobileError.Refused.instanceOf(error)) return error.inner.message;
  if (MobileError.Connection.instanceOf(error)) return error.inner.message;
  return String(error);
}

/** Macs left for good; a screen still open on one must not reconnect to it. */
const forgotten = new Set<string>();

export async function reloadDevices() {
  devices = await pairedDevices();
  devices.forEach((device) => forgotten.delete(device.core));
  devicesLoaded = true;
  changed();
}

async function refresh(core: string, connection: ConnectionLike) {
  const found = entry(core);
  try {
    const next = await snapshot(connection);
    if (found.live.status === 'open' && found.live.connection === connection) set(core, { ...found.live, snapshot: next });
  } catch (error) {
    if (found.live.status === 'open' && found.live.connection === connection) drop(core, problem(error));
  }
}

function stopTimers(found: Entry) {
  clearTimeout(found.refreshing);
  clearInterval(found.polling);
  clearTimeout(found.retrying);
}

function drop(core: string, reason: string, behind?: Outdated) {
  const found = entry(core);
  stopTimers(found);
  if (found.live.status === 'open') found.live.connection.close();
  set(core, { status: 'closed', problem: reason, outdated: behind, snapshot: found.live.snapshot });
  if (found.watchers > 0) {
    const wait = RETRY_MS[Math.min(found.attempt, RETRY_MS.length - 1)];
    found.attempt += 1;
    found.retrying = setTimeout(() => open(core), wait);
  }
}

async function open(core: string) {
  if (forgotten.has(core)) return;
  const found = entry(core);
  if (found.live.status === 'open') return;
  set(core, { status: 'connecting', snapshot: found.live.snapshot });
  try {
    const device = await thisDevice();
    const connection = await device.connect(core, {
      output: (session, bytes) => found.output.forEach((listen) => listen(session, bytes)),
      event: (json) => {
        found.events.forEach((listen) => listen(json));
        clearTimeout(found.refreshing);
        found.refreshing = setTimeout(() => refresh(core, connection), REFRESH_AFTER_MS);
      },
      closed: () => {
        if (found.live.status === 'open' && found.live.connection === connection) drop(core, 'The connection closed.');
      },
    });
    if (found.watchers === 0) {
      connection.close();
      set(core, { status: 'closed', problem: 'Not in use.', snapshot: found.live.snapshot });
      return;
    }
    found.attempt = 0;
    set(core, { status: 'open', connection, snapshot: found.live.snapshot });
    found.polling = setInterval(() => refresh(core, connection), POLL_MS);
    refresh(core, connection);
    host(connection)
      .then((info) => updateDevice(core, { name: info.name, model: info.model, channel: info.channel, lastSeen: Date.now() }))
      .then(reloadDevices)
      .catch(() => {});
  } catch (error) {
    drop(core, problem(error), outdated(error));
  }
}

/** Keeps a device connected while the caller is shown. */
function watch(core: string) {
  const found = entry(core);
  found.watchers += 1;
  clearTimeout(found.lingering);
  if (found.live.status !== 'open') {
    clearTimeout(found.retrying);
    open(core);
  }
  return () => {
    found.watchers -= 1;
    if (found.watchers > 0) return;
    found.lingering = setTimeout(() => {
      if (found.watchers > 0) return;
      stopTimers(found);
      if (found.live.status === 'open') found.live.connection.close();
      set(core, { status: 'closed', problem: 'Not in use.', snapshot: found.live.snapshot });
    }, LINGER_MS);
  };
}

AppState.addEventListener('change', (state) => {
  if (state !== 'active') return;
  entries.forEach((found, core) => {
    if (found.watchers > 0 && !(found.live.status === 'open' && found.live.connection.isOpen())) {
      clearTimeout(found.retrying);
      if (found.live.status === 'open') drop(core, 'The connection closed.');
      else open(core);
    }
  });
});

export function useDevices(): { devices: PairedDevice[]; loaded: boolean } {
  useEffect(() => {
    if (!devicesLoaded) reloadDevices();
  }, []);
  const list = useSyncExternalStore(subscribe, () => devices);
  const loaded = useSyncExternalStore(subscribe, () => devicesLoaded);
  return { devices: list, loaded };
}

/** One device's live state; the device stays connected while this is mounted. */
export function useLive(core: string): Live {
  useEffect(() => watch(core), [core]);
  return useSyncExternalStore(subscribe, () => entry(core).live);
}

/** Leaves a Mac for good: asks it to unpair this phone while it can, then drops the connection and forgets it. */
export async function forget(core: string) {
  forgotten.add(core);
  const found = entry(core);
  if (found.live.status === 'open') {
    const asked = found.live.connection.request(JSON.stringify({ op: 'unpair' })).catch(() => '');
    await Promise.race([asked, new Promise((settle) => setTimeout(settle, UNPAIR_WAIT_MS))]);
  }
  stopTimers(found);
  clearTimeout(found.lingering);
  if (found.live.status === 'open') found.live.connection.close();
  entries.delete(core);
  await forgetDevice(core);
  devices = await pairedDevices();
  changed();
}

export function retry(core: string) {
  const found = entry(core);
  clearTimeout(found.retrying);
  found.attempt = 0;
  if (found.live.status !== 'open') open(core);
}

export function onEvent(core: string, listen: (json: string) => void) {
  const found = entry(core);
  found.events.add(listen);
  return () => {
    found.events.delete(listen);
  };
}

export function onOutput(core: string, listen: (session: bigint, bytes: ArrayBuffer) => void) {
  const found = entry(core);
  found.output.add(listen);
  return () => {
    found.output.delete(listen);
  };
}
