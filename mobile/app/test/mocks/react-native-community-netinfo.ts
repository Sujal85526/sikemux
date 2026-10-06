type Listener = (state: unknown) => void;

/** Outlives `vi.resetModules`, so a test can move the network that a freshly imported module listens to. */
const shared = globalThis as { sikemuxNetInfo?: Set<Listener> };
const listeners = (shared.sikemuxNetInfo ??= new Set<Listener>());

export type NetInfoState = { type: string; isConnected: boolean | null; details: { ipAddress?: string | null } | null };

const NetInfo = {
  addEventListener(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Tells every listener the phone is now on `type`, or on no network at all. */
  emit(type: string, ipAddress: string | null = null) {
    const state = { type, isConnected: type !== 'none', details: type === 'none' ? null : { ipAddress } };
    for (const listener of listeners) listener(state);
  },
};

export default NetInfo;
