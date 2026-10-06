import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { durationLabel } from '@mac/chat/durationLabel';
import { rateLabel, sentLabel, type RowMeta } from '@mac/chat/messageMeta';
import { haptics } from '@/ui/haptics';
import { Icon } from '@/ui/Icon';
import type { IconName } from '@/ui/icons.generated';
import { Sheet } from '@/ui/Sheet';
import { fonts, type Palette, useColors, useStyles } from '@/ui/theme';

function metaLine(meta: RowMeta): string | null {
  const said = [
    meta.at !== null ? sentLabel(meta.at) : null,
    meta.took !== null ? `took ${durationLabel(meta.took)}` : null,
    meta.rate !== null ? rateLabel(meta.rate) : null,
  ].filter(Boolean);
  return said.length ? said.join(' · ') : null;
}

function Action({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && { backgroundColor: colors.active }]}
      accessibilityRole="button">
      <Icon name={icon} size={18} color={colors.ink} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

/** A long press's actions on a message: when it was sent and how long it took, Copy, and Select text. */
export function MessageSheet({ meta, onClose }: { meta: RowMeta | null; onClose: () => void }) {
  const styles = useStyles(makeStyles);
  const [selecting, setSelecting] = useState(false);
  const [shown, setShown] = useState(meta);
  if (meta && meta !== shown) {
    setShown(meta);
    setSelecting(false);
  }
  const line = shown ? metaLine(shown) : null;
  const text = shown?.text ?? '';
  return (
    <Sheet visible={meta !== null} onClose={onClose} tall={selecting}>
      {line ? <Text style={styles.meta}>{line}</Text> : null}
      {selecting ? (
        <Text style={styles.whole} selectable>
          {text}
        </Text>
      ) : (
        <>
          {text ? (
            <Text style={styles.preview} numberOfLines={3}>
              {text}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Action
              icon="IconCopy"
              label="Copy"
              onPress={() => {
                void Clipboard.setStringAsync(text).then(() => haptics.select());
                onClose();
              }}
            />
            <Action icon="IconPointer" label="Select text" onPress={() => setSelecting(true)} />
          </View>
        </>
      )}
    </Sheet>
  );
}

const makeStyles = (colors: Palette) => {
  return StyleSheet.create({
    meta: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.tertiary, paddingHorizontal: 6, paddingBottom: 10 },
    preview: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: colors.secondary, paddingHorizontal: 6, paddingBottom: 14 },
    whole: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 23, color: colors.ink, paddingHorizontal: 6, paddingBottom: 12 },
    actions: { gap: 8, paddingBottom: 4 },
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 52,
      paddingHorizontal: 14,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.raised,
    },
    actionText: { fontFamily: fonts.uiMedium, fontSize: 15.5, color: colors.ink },
  });
};
