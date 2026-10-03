import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@clerk/expo';

import { Button } from '@/ui/parts';
import { Sheet } from '@/ui/Sheet';
import { fonts, type Palette, typeFor, useStyles } from '@/ui/theme';
import { choose, closeOffer, useOffered } from './setting';
import { notificationsSupported, turnOn } from './switch';

/** Asked once, after the first pairing on a signed-in phone, since notifications reach it through the account. */
export function NotificationsOffer() {
  const styles = useStyles(makeStyles);
  const { isSignedIn, getToken } = useAuth();
  const offered = useOffered();
  const visible = offered && !!isSignedIn && notificationsSupported;

  const notNow = () => {
    closeOffer();
    void choose('off');
  };

  const accept = () => {
    closeOffer();
    turnOn(() => getToken()).catch((error: unknown) => console.warn('sikemux: could not turn on notifications', error));
  };

  return (
    <Sheet visible={visible} onClose={notNow}>
      <Text style={styles.title}>Turn on notifications?</Text>
      <Text style={styles.note}>
        Get told when an agent stops to ask, finishes, or runs into a problem. What it&apos;s doing is encrypted on your computer; only this
        phone can read it.
      </Text>
      <View style={styles.choices}>
        <Button title="Not now" onPress={notNow} style={styles.choice} />
        <Button kind="primary" title="Turn on" onPress={accept} style={styles.choice} />
      </View>
    </Sheet>
  );
}

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    title: { fontFamily: fonts.uiSemibold, fontSize: 15, color: colors.ink, paddingHorizontal: 8, paddingTop: 12 },
    note: { ...type.meta, lineHeight: 19, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 12 },
    choices: { flexDirection: 'row', gap: 8 },
    choice: { flex: 1 },
  });
};
