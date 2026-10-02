import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { Button } from '@/ui/parts';
import { Sheet } from '@/ui/Sheet';
import { fonts, type Palette, useStyles, useType } from '@/ui/theme';
import { forgetBackdrop } from './backdrop';
import { forget } from './hub';
import { deviceName, type PairedDevice } from './paired';

/** The device screen's options: for now, forgetting the Mac. */
export function ForgetSheet({ device, visible, onClose }: { device: PairedDevice; visible: boolean; onClose: () => void }) {
  const styles = useStyles(makeStyles);
  const type = useType();
  const [forgetting, setForgetting] = useState(false);
  const name = deviceName(device);

  const leave = async () => {
    setForgetting(true);
    forgetBackdrop(device.backdrop);
    await forget(device.core);
    onClose();
    router.replace('/');
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {name}
        </Text>
        <Text style={type.body}>
          Forgetting removes this Mac from the phone and, if it can be reached, removes this phone from the Mac's paired devices. To
          use it again, pair with its code.
        </Text>
        <Button kind="danger" title={forgetting ? 'Forgetting…' : 'Forget this Mac'} onPress={leave} style={styles.button} />
      </View>
    </Sheet>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    body: { paddingHorizontal: 4, gap: 12 },
    title: { fontFamily: fonts.uiSemibold, fontSize: 17, letterSpacing: -0.35, color: colors.ink },
    button: { marginTop: 8 },
  });
