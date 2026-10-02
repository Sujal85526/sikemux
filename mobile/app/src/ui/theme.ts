import type { TextStyle } from 'react-native';

/** Aura Noir, the Mac app's default theme, with its neutral ramp mixed the same way (DESIGN.md §3). */
export const colors = {
  sunken: '#09090b',
  ground: '#0f0f13',
  raised: '#18181c',
  overlay: '#1e1e22',
  composer: '#111114',
  border: '#27272b',
  borderStrong: '#3f3f43',
  rest: '#6a6a6f',

  ink: '#e7e5ef',
  secondary: '#b3b2ba',
  tertiary: '#86858c',
  inkDim: '#8b8898',
  inkFaint: '#736f80',

  active: 'rgba(231, 229, 239, 0.10)',
  selected: 'rgba(162, 119, 255, 0.14)',
  borderSelected: 'rgba(162, 119, 255, 0.42)',

  accent: '#a277ff',
  accentSoft: 'rgba(162, 119, 255, 0.10)',
  live: '#61ffca',
  danger: '#ff6767',
  cmd: '#ff6ac1',
  gitAdded: '#81b88b',
  gitModified: '#e2c08d',
  gitDeleted: '#d75f47',
  gitRenamed: '#6c8cd5',
} as const;

export const brand = {
  claude: '#d97757',
  codex: '#7a9dff',
  hermes: '#e0a050',
  opencode: '#a78bfa',
  pi: '#7dd3fc',
  omp: '#f97316',
  grok: '#fcfcfc',
} as const;

export type Provider = keyof typeof brand;

export const fonts = {
  ui: 'Figtree_400Regular',
  uiMedium: 'Figtree_500Medium',
  uiSemibold: 'Figtree_600SemiBold',
  uiItalic: 'Figtree_400Regular_Italic',
  mono: 'JetBrainsMono_400Regular',
} as const;

/** Text the app says is Figtree; text the machine says is mono (DESIGN.md §1). */
export const type = {
  title: { fontFamily: fonts.uiSemibold, fontSize: 24, letterSpacing: -0.7, color: colors.ink },
  heading: { fontFamily: fonts.uiSemibold, fontSize: 17, letterSpacing: -0.35, color: colors.ink },
  body: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: colors.secondary },
  row: { fontFamily: fonts.uiMedium, fontSize: 15.5, letterSpacing: -0.15, color: colors.secondary },
  meta: { fontFamily: fonts.ui, fontSize: 13, color: colors.tertiary },
  label: { fontFamily: fonts.uiSemibold, fontSize: 13, color: colors.tertiary },
  mono: { fontFamily: fonts.mono, fontSize: 12, color: colors.tertiary },
} satisfies Record<string, TextStyle>;

export const radius = { control: 10, row: 12, card: 14, sheet: 22 } as const;
