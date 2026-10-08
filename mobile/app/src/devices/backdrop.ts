import { useEffect, useState } from 'react';
import { Directory, File, Paths } from 'expo-file-system';

import { reloadDevices, useDevices, useLive } from './hub';
import { updateDevice, type PairedDevice } from './paired';

export type DeviceBackdrop = { texture: boolean; image?: string };

/** A host hands over whichever picture it has now, so each host has one fetch at a time. */
const fetching = new Set<string>();
/** Pictures the host said it does not have; asking again on every change of its view would not help. */
const missing = new Set<string>();
/** When fetching each picture last failed; it is asked for again once this long has passed. */
const failedAt = new Map<string, number>();
const RETRY_FAILED_MS = 60_000;
/** The picture each host's view names now, to tell a fetch that finished after its host moved on. */
const latest = new Map<string, string>();

function folder(core: string): Directory {
  return new Directory(Paths.document, 'backdrops', core.slice(0, 16));
}

/** Deletes the picture saved for a host's backdrop. */
export function forgetBackdrop(saved: PairedDevice['backdrop']) {
  if (!saved?.image) return;
  const file = new File(saved.image.uri);
  if (file.exists) file.delete();
}

/** What a host draws behind its panes: as it publishes it, or as last seen. Its picture is fetched only when it changes. */
export function useDeviceBackdrop(core: string): DeviceBackdrop {
  const live = useLive(core);
  const { devices } = useDevices();
  const remembered = devices.find((device) => device.core === core)?.backdrop;
  const published = live.snapshot?.workspace.backdrop;
  const texture = published?.texture;
  const wanted = published ? (published.image ?? null) : undefined;
  const connection = live.status === 'open' ? live.connection : undefined;

  const [fetches, setFetches] = useState(0);

  useEffect(() => {
    if (texture === undefined || wanted === undefined) return;
    if (wanted && wanted !== remembered?.image?.id) {
      const key = `${core}/${wanted}`;
      latest.set(core, wanted);
      if (!connection || fetching.has(core) || missing.has(key)) return;
      if (Date.now() - (failedAt.get(key) ?? -Infinity) < RETRY_FAILED_MS) return;
      fetching.add(core);
      // The Rust client decodes and writes the picture, so megabytes of it never pass through JavaScript.
      const dir = decodeURIComponent(folder(core).uri.replace(/^file:\/\//, ''));
      connection
        .saveBackdrop(dir, wanted)
        .then((path) => {
          if (!path) {
            missing.add(key);
            return;
          }
          const saved = new File(`file://${path}`);
          // Saved under the name asked for, but it is whatever the host shows now, which may already be another.
          if (latest.get(core) !== wanted) {
            if (saved.exists) saved.delete();
            return;
          }
          failedAt.delete(key);
          forgetBackdrop(remembered);
          return updateDevice(core, { backdrop: { texture, image: { id: wanted, uri: saved.uri } } }).then(reloadDevices);
        })
        .catch(() => failedAt.set(key, Date.now()))
        .finally(() => {
          fetching.delete(core);
          setFetches((count) => count + 1);
        });
      return;
    }
    if (!wanted && remembered?.image) forgetBackdrop(remembered);
    if (texture !== remembered?.texture || (!wanted && remembered?.image)) {
      updateDevice(core, { backdrop: { texture, image: wanted ? remembered?.image : undefined } }).then(reloadDevices, () => {});
    }
  }, [core, connection, texture, wanted, remembered, fetches]);

  const shown = texture ?? remembered?.texture ?? false;
  const current = wanted === undefined ? remembered?.image?.id : wanted;
  const image = current && remembered?.image?.id === current ? remembered.image.uri : undefined;
  return { texture: shown, image };
}
