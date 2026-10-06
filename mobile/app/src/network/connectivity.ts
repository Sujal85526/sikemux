import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

/** `regained`: the phone has a network again after having none. `moved`: it went from one network to another. */
export type NetworkChange = 'regained' | 'moved';

type Seen = { connected: boolean; network: string };

function seen(state: NetInfoState): Seen {
  const address = state.details && 'ipAddress' in state.details ? state.details.ipAddress : null;
  return { connected: state.isConnected !== false, network: `${state.type}:${address ?? ''}` };
}

/** Calls `listen` on each change of network that can leave a connection dead without it noticing. */
export function onNetworkChange(listen: (change: NetworkChange) => void): () => void {
  let last: Seen | undefined;
  return NetInfo.addEventListener((state) => {
    const before = last;
    const now = seen(state);
    last = now;
    if (!before || !now.connected) return;
    if (!before.connected) listen('regained');
    else if (before.network !== now.network) listen('moved');
  });
}
