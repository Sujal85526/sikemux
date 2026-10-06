import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/ui/Icon';
import { fonts, type Palette, useColors, useStyles } from '@/ui/theme';
import { sizeLabel } from './pick';
import type { Attachment } from './session';

const IMAGE_PATH = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i;

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function FileChip({ name, size, image, tall }: { name: string; size?: number; image?: boolean; tall?: boolean }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.chip, tall && styles.chipTall]}>
      <Icon name={image ? 'IconImage' : 'IconFile'} size={tall ? 20 : 16} color={colors.inkDim} />
      <View style={styles.chipWords}>
        <Text style={styles.chipName} numberOfLines={1} ellipsizeMode="middle">
          {name}
        </Text>
        {size !== undefined ? <Text style={styles.chipSize}>{sizeLabel(size)}</Text> : null}
      </View>
    </View>
  );
}

/** What is picked for the next message, above the composer's text, each with its upload's state. */
export function ComposerAttachments({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: readonly Attachment[];
  onRemove: (id: string) => void;
  onRetry: () => void;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const failed = attachments.filter((attachment) => attachment.upload === 'failed');
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
        {attachments.map((attachment) => {
          const sending = attachment.upload === 'sending';
          const broken = attachment.upload === 'failed';
          return (
            <Pressable
              key={attachment.id}
              disabled={!broken}
              onPress={onRetry}
              style={[styles.item, attachment.kind === 'image' ? styles.thumb : styles.fileItem, broken && { borderColor: colors.danger }]}
              accessibilityRole={broken ? 'button' : undefined}
              accessibilityLabel={
                broken
                  ? `${attachment.name} did not reach the host${attachment.problem ? `: ${attachment.problem}` : ''}. Try again`
                  : `${attachment.name}${sending ? ', sending' : ''}`
              }>
              {attachment.kind === 'image' ? (
                <Image source={{ uri: attachment.uri }} style={styles.thumbImage} resizeMode="cover" />
              ) : (
                <FileChip name={attachment.name} size={attachment.size} tall />
              )}
              {sending || broken ? (
                <View style={styles.veil}>
                  {sending ? <ActivityIndicator color={colors.ink} /> : <Icon name="IconRefresh" size={18} color={colors.ink} />}
                </View>
              ) : (
                <Pressable
                  onPress={() => onRemove(attachment.id)}
                  hitSlop={8}
                  style={styles.remove}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${attachment.name}`}>
                  <Icon name="IconClose" size={10} color={colors.ground} />
                </Pressable>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
      {failed.length ? (
        <Text style={styles.problem} numberOfLines={2}>
          {failed.length === 1 ? `${failed[0].name} did not reach the host` : `${failed.length} files did not reach the host`}
          {failed[0].problem ? `: ${failed[0].problem}` : ''}. Tap to try again.
        </Text>
      ) : null}
    </View>
  );
}

/** The files a message carried, as this phone picked them or, for the host's own, by name. */
export function SentAttachments({ paths, sentFiles }: { paths: readonly string[]; sentFiles: ReadonlyMap<string, Attachment> }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.sent}>
      {paths.map((path) => {
        const picked = sentFiles.get(path);
        if (picked?.kind === 'image') {
          return (
            <Image
              key={path}
              source={{ uri: picked.uri }}
              style={styles.sentThumb}
              resizeMode="cover"
              accessible
              accessibilityLabel={picked.name}
            />
          );
        }
        return (
          <View key={path} accessible accessibilityLabel={`File ${baseName(path)}`}>
            <FileChip name={picked?.name ?? baseName(path)} size={picked?.size} image={IMAGE_PATH.test(path)} />
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Palette) => {
  return StyleSheet.create({
    row: { gap: 7, paddingHorizontal: 4, paddingTop: 4, paddingBottom: 2 },
    item: { height: 58, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.sunken, overflow: 'hidden' },
    thumb: { width: 76 },
    thumbImage: { width: '100%', height: '100%' },
    fileItem: { maxWidth: 190, justifyContent: 'center' },
    veil: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(9, 9, 11, 0.55)' },
    remove: {
      position: 'absolute',
      top: 4,
      right: 4,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: colors.ink,
      alignItems: 'center',
      justifyContent: 'center',
    },
    problem: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 16, color: colors.danger, paddingHorizontal: 6, paddingTop: 6 },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      maxWidth: 220,
      paddingVertical: 7,
      paddingHorizontal: 10,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.raised,
    },
    chipTall: { height: '100%', maxWidth: undefined, paddingRight: 30, borderWidth: 0, borderRadius: 0, backgroundColor: 'transparent' },
    chipWords: { flexShrink: 1 },
    chipName: { fontFamily: fonts.mono, fontSize: 12, color: colors.ink },
    chipSize: { fontFamily: fonts.ui, fontSize: 11, color: colors.inkFaint, marginTop: 2 },
    sent: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-end',
      justifyContent: 'flex-end',
      gap: 6,
      maxWidth: '84%',
      marginBottom: 6,
    },
    sentThumb: { width: 132, height: 99, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.sunken },
  });
};
