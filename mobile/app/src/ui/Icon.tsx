import { parse, SvgAst, type JsxAST } from 'react-native-svg';

import { ICONS, type IconName } from './icons.generated';
import { brand, type Provider, useColors } from './theme';

/** Glyphs the Mac app has no icon for, drawn on its 16px grid and 1.4 stroke. */
const DRAWN_ICONS = {
  laptop: '<rect x="3" y="3.2" width="10" height="7.3" rx="1.2"/><path d="M1.6 12.6h12.8"/>',
  desktop: '<rect x="1.9" y="2.4" width="12.2" height="8.6" rx="1.3"/><path d="M8 11v2.4M5.8 13.6h4.4"/>',
  mini: '<rect x="1.9" y="5.6" width="12.2" height="4.8" rx="1.7"/><path d="M4.4 12.4h7.2"/>',
  folders: '<path d="M4 3h3l1.3 1.6H14v6"/><path d="M2 5.6h3.6l1.4 1.8H12v6H2z"/>',
} as const;

export type DeviceKind = 'laptop' | 'desktop' | 'mini';

const parsed = new Map<string, JsxAST | null>();

function svg(xml: string): JsxAST | null {
  if (!parsed.has(xml)) parsed.set(xml, parse(xml));
  return parsed.get(xml) ?? null;
}

export function Icon({ name, size = 16, color }: { name: IconName; size?: number; color?: string }) {
  const colors = useColors();
  return <SvgAst ast={svg(ICONS[name])} override={{ width: size, height: size, color: color ?? colors.secondary }} />;
}

export function DrawnIcon({ name, size = 16, color }: { name: keyof typeof DRAWN_ICONS; size?: number; color?: string }) {
  const colors = useColors();
  const xml = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${DRAWN_ICONS[name]}</svg>`;
  return <SvgAst ast={svg(xml)} override={{ width: size, height: size, color: color ?? colors.secondary }} />;
}

export function DeviceIcon({ kind, size = 30, color }: { kind: DeviceKind; size?: number; color?: string }) {
  const colors = useColors();
  return <DrawnIcon name={kind} size={size} color={color ?? colors.ink} />;
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
  const colors = useColors();
  if (!isProvider(provider)) return <Icon name="IconAgent" size={size} color={colors.secondary} />;
  return <Icon name={PROVIDER_ICONS[provider]} size={size} color={brand[provider]} />;
}
