import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts } from './theme';

/** A sheet that slides up over the screen; a tap on the dimmed screen closes it. */
export function Sheet({ visible, onClose, tall, children }: { visible: boolean; onClose: () => void; tall?: boolean; children: ReactNode }) {
  // A modal measures no safe area of its own, so the screen behind it lends its inset.
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, tall && { height: '82%' }, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.grabber} />
        {children}
      </View>
    </Modal>
  );
}

export function SheetLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(9, 9, 11, 0.62)' },
  sheet: {
    backgroundColor: colors.overlay,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: colors.borderStrong, marginBottom: 12 },
  label: { fontFamily: fonts.uiSemibold, fontSize: 13, color: colors.tertiary, paddingTop: 14, paddingBottom: 8, paddingHorizontal: 6 },
});
