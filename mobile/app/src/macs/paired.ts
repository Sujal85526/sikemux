import * as SecureStore from 'expo-secure-store';

export type Access = 'full' | 'watch';

export type PairedMac = { core: string; access: Access; pairedAt: number };

const MACS_ITEM = 'sikemux.paired-macs';

export async function pairedMacs(): Promise<PairedMac[]> {
  const stored = await SecureStore.getItemAsync(MACS_ITEM);
  return stored ? (JSON.parse(stored) as PairedMac[]) : [];
}

export async function rememberMac(mac: PairedMac): Promise<void> {
  const others = (await pairedMacs()).filter((known) => known.core !== mac.core);
  await SecureStore.setItemAsync(MACS_ITEM, JSON.stringify([...others, mac]));
}

export async function forgetMac(core: string): Promise<void> {
  const others = (await pairedMacs()).filter((known) => known.core !== core);
  await SecureStore.setItemAsync(MACS_ITEM, JSON.stringify(others));
}

export function shortKey(key: string): string {
  return key.slice(0, 8);
}
