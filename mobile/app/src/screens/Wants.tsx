import { Text } from 'react-native';

import type { Attention } from '@/core/protocol';
import { asking } from '@/devices/asking';
import { fonts, useColors } from '@/ui/theme';

/** "wants to run `pnpm test`", set inside a line of text; nothing when the request names nothing. */
export function Wants({ attention, lead = '' }: { attention?: Attention; lead?: string }) {
  const colors = useColors();
  const ask = attention ? asking(attention) : null;
  if (!ask) return null;
  return (
    <>
      {lead}wants to {ask.verb} <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.secondary }}>{ask.target}</Text>
    </>
  );
}
