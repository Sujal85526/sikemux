import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { MobileError, type ConnectionLike } from '@sikemux/native';

import { thisDevice } from '@/device/identity';
import { snapshot, type Snapshot } from '@/core/protocol';

export type MacState =
  | { state: 'connecting' }
  | { state: 'open'; connection: ConnectionLike; snapshot?: Snapshot }
  | { state: 'closed'; problem: string };

/** Many events arrive together when an agent works; one refresh covers them. */
const REFRESH_AFTER_MS = 250;
/** The core announces no new terminals or chats, so the phone asks again this often. */
const POLL_MS = 5000;

function connectionProblem(error: unknown): string {
  if (MobileError.Refused.instanceOf(error)) return error.inner.message;
  if (MobileError.Connection.instanceOf(error)) return `Could not reach the Mac: ${error.inner.message}`;
  return String(error);
}

/** One open connection to a paired Mac while the screen is shown, opened again when the app returns. */
export function useMac(core: string) {
  const [mac, setMac] = useState<MacState>({ state: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt((count) => count + 1), []);
  const live = useRef<ConnectionLike>(undefined);

  useEffect(() => {
    let current = true;
    let refreshing: ReturnType<typeof setTimeout> | undefined;
    let polling: ReturnType<typeof setInterval> | undefined;
    setMac({ state: 'connecting' });

    const refresh = (connection: ConnectionLike) => {
      snapshot(connection)
        .then((next) => current && setMac({ state: 'open', connection, snapshot: next }))
        .catch((error: unknown) => current && setMac({ state: 'closed', problem: connectionProblem(error) }));
    };

    thisDevice()
      .then((device) =>
        device.connect(core, {
          output: () => {},
          event: () => {
            clearTimeout(refreshing);
            refreshing = setTimeout(() => live.current && refresh(live.current), REFRESH_AFTER_MS);
          },
          closed: () => {
            clearInterval(polling);
            if (current) setMac({ state: 'closed', problem: 'The Mac closed the connection.' });
          },
        }),
      )
      .then((connection) => {
        if (!current) {
          connection.close();
          return;
        }
        live.current = connection;
        setMac({ state: 'open', connection });
        refresh(connection);
        polling = setInterval(() => refresh(connection), POLL_MS);
      })
      .catch((error: unknown) => current && setMac({ state: 'closed', problem: connectionProblem(error) }));

    return () => {
      current = false;
      clearTimeout(refreshing);
      clearInterval(polling);
      live.current?.close();
      live.current = undefined;
    };
  }, [core, attempt]);

  useEffect(() => {
    const watching = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !live.current?.isOpen()) reconnect();
    });
    return () => watching.remove();
  }, [reconnect]);

  return { mac, reconnect };
}
