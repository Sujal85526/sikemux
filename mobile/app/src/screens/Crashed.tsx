import { StyleSheet, Text, View } from 'react-native';
import type { ErrorBoundaryProps } from 'expo-router';

import { goHome } from '@/ui/navigate';
import { Button } from '@/ui/controls';
import { Screen, useBottomGap } from '@/ui/screen';
import { type Palette, typeFor, useStyles } from '@/ui/theme';

/** What a screen shows in place of itself when drawing it threw. */
export function Crashed({ error, retry }: ErrorBoundaryProps) {
  const styles = useStyles(makeStyles);
  const bottom = useBottomGap();
  return (
    <Screen>
      <View style={styles.block}>
        <Text style={styles.title} accessibilityRole="header">
          Something went wrong
        </Text>
        <Text style={styles.body} selectable>
          {error.message}
        </Text>
      </View>
      <View style={[styles.footer, { paddingBottom: bottom }]}>
        <Button kind="primary" title="Try again" onPress={() => retry().catch(() => {})} />
        <Button kind="text" title="Go to Devices" onPress={goHome} />
      </View>
    </Screen>
  );
}

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    block: { flex: 1, justifyContent: 'center', paddingHorizontal: 32, paddingBottom: 120 },
    title: { ...type.title, fontSize: 22, textAlign: 'center' },
    body: { ...type.body, textAlign: 'center', marginTop: 10 },
    footer: { paddingHorizontal: 16, paddingTop: 12, gap: 4 },
  });
};
