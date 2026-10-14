import { AppState } from 'react-native';
import { useEffect, useState } from 'react';
import type { ConnectionLike } from '@sikemux/native';

import { readDigest, type Digest } from '@/core/protocol';

/** Back in the app after this long away counts as away. */
const AWAY_MS = 10 * 60_000;
/** Hosts whose digest this launch already asked for. */
const asked = new Set<string>();

/**
 * What finished and failed on the host while the person was away: since the app went to the background, once it has
 * been away a while, or on the first visit after launch, since the person left the host, if they still are.
 */
export function useDigest(core: string, connection: ConnectionLike | undefined) {
  const [digest, setDigest] = useState<Digest>();
  const [request, setRequest] = useState<{ since?: number } | undefined>(() => (asked.has(core) ? undefined : {}));

  useEffect(() => {
    let left: number | undefined;
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'background') left ??= Date.now();
      if (state !== 'active' || left === undefined) return;
      if (Date.now() - left >= AWAY_MS) setRequest({ since: left });
      left = undefined;
    });
    return () => listener.remove();
  }, []);

  useEffect(() => {
    if (!connection || !request) return;
    asked.add(core);
    let current = true;
    connection.call('digest', JSON.stringify(request)).then(
      (text) => {
        if (!current) return;
        const read = readDigest(text);
        const shown = (request.since !== undefined || read.away) && read.finished.length + read.failed.length > 0;
        setDigest(shown ? read : undefined);
        setRequest(undefined);
      },
      () => {
        if (current) setRequest(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [core, connection, request]);

  return { digest, dismiss: () => setDigest(undefined) };
}
