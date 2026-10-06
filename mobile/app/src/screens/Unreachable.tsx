import { StyleSheet, Text, View } from 'react-native';
import { reloadAppAsync } from 'expo';

import { Button } from '@/ui/controls';
import { Screen, useBottomGap } from '@/ui/screen';
import { type Palette, typeFor, useStyles } from '@/ui/theme';

/** Shown when the account can't be read at launch: the first launch offline, or the accounts server out of reach. */
export function Unreachable() {
  const styles = useStyles(makeStyles);
  const bottom = useBottomGap();
  return (
    <Screen>
      <View style={styles.block}>
        <Text style={styles.title} accessibilityRole="header">
          Can&apos;t reach Sikemux
        </Text>
        <Text style={styles.body}>This phone needs the internet once to load your account. Check the connection, then try again.</Text>
      </View>
      <View style={[styles.footer, { paddingBottom: bottom }]}>
        <Button kind="primary" title="Try again" onPress={() => reloadAppAsync().catch(() => {})} />
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
    footer: { paddingHorizontal: 16, paddingTop: 12 },
  });
};
