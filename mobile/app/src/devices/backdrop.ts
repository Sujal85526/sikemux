import { useEffect } from 'react';
import { Directory, File, Paths } from 'expo-file-system';

import { reloadDevices, useDevices, useLive } from './hub';
import { updateDevice, type PairedDevice } from './paired';

export type DeviceBackdrop = { texture: boolean; image?: string };

const fetching = new Set<string>();

function save(core: string, id: string, dataUrl: string): string {
  const folder = new Directory(Paths.document, 'backdrops');
  folder.create({ idempotent: true });
  const file = new File(folder, `${core.slice(0, 16)}-${id}.jpg`);
  file.write(dataUrl.slice(dataUrl.indexOf(',') + 1), { encoding: 'base64' });
  return file.uri;
}

function forget(saved: PairedDevice['backdrop']) {
  if (!saved?.image) return;
  const file = new File(saved.image.uri);
  if (file.exists) file.delete();
}

/** What a Mac draws behind its panes: as it publishes it, or as last seen. Its picture is fetched only when it changes. */
export function useDeviceBackdrop(core: string): DeviceBackdrop {
  const live = useLive(core);
  const { devices } = useDevices();
  const remembered = devices.find((device) => device.core === core)?.backdrop;
  const published = live.snapshot?.workspace.backdrop;
  const connection = live.status === 'open' ? live.connection : undefined;

  useEffect(() => {
    if (!published) return;
    const wanted = published.image;
    if (wanted && wanted !== remembered?.image?.id) {
      if (!connection || fetching.has(core)) return;
      fetching.add(core);
      connection
        .request(JSON.stringify({ op: 'backdropImage' }))
        .then((text) => {
          const answer = JSON.parse(text) as { dataUrl?: string | null };
          if (!answer.dataUrl) return;
          const uri = save(core, wanted, answer.dataUrl);
          forget(remembered);
          return updateDevice(core, { backdrop: { texture: published.texture, image: { id: wanted, uri } } }).then(reloadDevices);
        })
        .catch(() => {})
        .finally(() => fetching.delete(core));
      return;
    }
    if (!wanted && remembered?.image) forget(remembered);
    if (published.texture !== remembered?.texture || (!wanted && remembered?.image)) {
      updateDevice(core, { backdrop: { texture: published.texture, image: wanted ? remembered?.image : undefined } }).then(reloadDevices);
    }
  }, [core, connection, published, remembered]);

  const texture = published?.texture ?? remembered?.texture ?? false;
  const current = published ? published.image : remembered?.image?.id;
  const image = current && remembered?.image?.id === current ? remembered.image.uri : undefined;
  return { texture, image };
}
