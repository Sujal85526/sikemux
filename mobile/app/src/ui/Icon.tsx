import { SvgXml } from 'react-native-svg';

import { ICONS, type IconName } from './icons.generated';
import { brand, colors, type Provider } from './theme';

/** Devices the Mac app has no icon for, drawn on its 16px grid and 1.4 stroke. */
const DEVICE_ICONS = {
  laptop: '<rect x="3" y="3.2" width="10" height="7.3" rx="1.2"/><path d="M1.6 12.6h12.8"/>',
  desktop: '<rect x="1.9" y="2.4" width="12.2" height="8.6" rx="1.3"/><path d="M8 11v2.4M5.8 13.6h4.4"/>',
  mini: '<rect x="1.9" y="5.6" width="12.2" height="4.8" rx="1.7"/><path d="M4.4 12.4h7.2"/>',
} as const;

export type DeviceKind = keyof typeof DEVICE_ICONS;

export function Icon({ name, size = 16, color = colors.secondary }: { name: IconName; size?: number; color?: string }) {
  return <SvgXml xml={ICONS[name]} width={size} height={size} color={color} />;
}

export function DeviceIcon({ kind, size = 30, color = colors.ink }: { kind: DeviceKind; size?: number; color?: string }) {
  const xml = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${DEVICE_ICONS[kind]}</svg>`;
  return <SvgXml xml={xml} width={size} height={size} color={color} />;
}

const PROVIDER_ICONS: Record<Provider, IconName> = {
  claude: 'IconClaude',
  codex: 'IconCodex',
  hermes: 'IconHermes',
  opencode: 'IconOpenCode',
  pi: 'IconPi',
  omp: 'IconOmp',
  grok: 'IconGrok',
};

export function isProvider(name: string): name is Provider {
  return name in PROVIDER_ICONS;
}

/** An agent's logo in its brand colour, as the Mac's AgentIcon draws it. */
export function AgentIcon({ provider, size = 20 }: { provider: string; size?: number }) {
  if (!isProvider(provider)) return <Icon name="IconAgent" size={size} color={colors.secondary} />;
  return <Icon name={PROVIDER_ICONS[provider]} size={size} color={brand[provider]} />;
}
