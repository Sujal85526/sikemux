import { Stack, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { useDevicePalette } from '@/devices/palette';
import { isLight, PaletteProvider } from '@/ui/theme';

/** A Mac's screens, drawn in that Mac's theme. */
export default function DeviceLayout() {
  const { core } = useLocalSearchParams<{ core: string }>();
  const palette = useDevicePalette(core);
  return (
    <PaletteProvider value={palette}>
      <StatusBar style={isLight(palette) ? 'dark' : 'light'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.ground } }} />
    </PaletteProvider>
  );
}
