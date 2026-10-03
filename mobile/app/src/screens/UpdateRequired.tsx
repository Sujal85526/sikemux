import { Linking, StyleSheet, Text, View } from 'react-native';

import type { UpdateRequired as Required } from '@/network/network';
import { updateLink } from '@/network/installed';
import { Button, Screen, useBottomGap } from '@/ui/parts';
import { type Palette, typeFor, useStyles } from '@/ui/theme';

/** The only screen while the installed app is older than the accounts server works with. */
export function UpdateRequired({ required }: { required: Required }) {
  const styles = useStyles(makeStyles);
  const bottom = useBottomGap();
  return (
    <Screen>
      <View style={styles.block}>
        <Text style={styles.title}>Update Sikemux</Text>
        <Text style={styles.body}>
          This version, {required.current}, is older than Sikemux works with now. Install {required.minimum} or later to reach your hosts
          again.
        </Text>
      </View>
      <View style={[styles.footer, { paddingBottom: bottom }]}>
        <Button kind="primary" title="Get the update" onPress={() => Linking.openURL(updateLink()).catch(() => {})} />
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
