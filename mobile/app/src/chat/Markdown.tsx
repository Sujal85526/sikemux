import { Fragment, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { fonts, type Palette, useStyles } from '@/ui/theme';

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'item'; marker: string; text: string }
  | { kind: 'code'; text: string };

function blocks(source: string): Block[] {
  const out: Block[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (index += 1; index < lines.length && !/^\s*```/.test(lines[index]); index += 1) code.push(lines[index]);
      out.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (heading) {
      flush();
      out.push({ kind: 'heading', text: heading[1] });
    } else if (bullet) {
      flush();
      out.push({ kind: 'item', marker: '•', text: bullet[1] });
    } else if (numbered) {
      flush();
      out.push({ kind: 'item', marker: `${numbered[1]}.`, text: numbered[2] });
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return out;
}

/** `code` as the Mac's purple chip, **bold** as semibold; everything else as written. */
function inline(text: string, styles: Styles): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((piece, index) => {
    if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 1) {
      return (
        <Text key={index} style={styles.chip}>
          {piece.slice(1, -1)}
        </Text>
      );
    }
    if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
      return (
        <Text key={index} style={styles.bold}>
          {piece.slice(2, -2)}
        </Text>
      );
    }
    return <Fragment key={index}>{piece}</Fragment>;
  });
}

export function Markdown({ text, style }: { text: string; style: TextStyle }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.stack}>
      {blocks(text).map((block, index) => {
        switch (block.kind) {
          case 'code':
            return (
              <ScrollView key={index} horizontal style={styles.code} contentContainerStyle={{ padding: 10 }}>
                <Text style={styles.codeText}>{block.text}</Text>
              </ScrollView>
            );
          case 'heading':
            return (
              <Text key={index} style={[style, styles.bold]}>
                {inline(block.text, styles)}
              </Text>
            );
          case 'item':
            return (
              <View key={index} style={styles.item}>
                <Text style={[style, styles.marker]}>{block.marker}</Text>
                <Text style={[style, { flex: 1 }]}>{inline(block.text, styles)}</Text>
              </View>
            );
          default:
            return (
              <Text key={index} style={style}>
                {inline(block.text, styles)}
              </Text>
            );
        }
      })}
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
  stack: { gap: 10 },
  chip: { fontFamily: fonts.mono, fontSize: 13, color: colors.accent, backgroundColor: colors.accentSoft },
  bold: { fontFamily: fonts.uiSemibold, color: colors.ink },
  item: { flexDirection: 'row', gap: 8, paddingLeft: 2 },
  marker: { color: colors.tertiary, minWidth: 14 },
  code: { borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.sunken },
  codeText: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, color: colors.ink },
});

type Styles = ReturnType<typeof makeStyles>;
