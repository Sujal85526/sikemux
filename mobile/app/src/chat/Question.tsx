import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { viaNote, type AgentQuestion } from '@mac/agents/agentQuestions';
import { haptics } from '@/ui/haptics';
import { AgentIcon } from '@/ui/Icon';
import { fonts, type Palette, useColors, useStyles } from '@/ui/theme';

/** Who is asking, above the question itself. */
function AskedBy({ cli, children }: { cli: string; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.who}>
      <AgentIcon provider={cli} size={14} />
      <Text style={styles.whoText} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

/** A question as it reads once answered: its words, and the answer in one line. */
export function AnsweredQuestion({ asker, cli, question, answer }: { asker: string; cli: string; question: string; answer: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View>
      <AskedBy cli={cli}>
        <Text style={styles.name}>{asker}</Text> asked you
      </AskedBy>
      <Text style={styles.prose} selectable>
        {question}
      </Text>
      <Text style={styles.answered} selectable>
        You answered: <Text style={styles.answer}>{answer}</Text>
      </Text>
    </View>
  );
}

/**
 * A question an agent put to the person, at the end of its chat: its words as prose, then the answers it offered as
 * numbered rows. "Something else…" hands over to the composer. A watching phone shows the question without the rows.
 */
export function OpenQuestion({
  question,
  canAnswer,
  busy,
  writing,
  onChoose,
  onWrite,
}: {
  question: AgentQuestion;
  canAnswer: boolean;
  busy: boolean;
  writing: boolean;
  onChoose: (choice: number) => void;
  onWrite: () => void;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const via = viaNote(question);
  const row = (key: string | number, number: number, label: string, detail: string | undefined, other: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      disabled={busy}
      onPress={() => {
        haptics.select();
        onPress();
      }}
      style={({ pressed }) => [styles.option, (pressed || (other && writing)) && { backgroundColor: colors.active }]}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityState={{ disabled: busy }}>
      <Text style={styles.key}>{number}</Text>
      <Text style={[styles.label, other && { color: colors.inkDim }]}>
        {label}
        {detail ? <Text style={styles.why}>{`   ${detail}`}</Text> : null}
      </Text>
    </Pressable>
  );
  return (
    <View accessibilityLiveRegion="polite">
      <AskedBy cli={question.cli}>
        <Text style={styles.name}>{question.name}</Text> asks you{via ? ` · ${via}` : ''}
      </AskedBy>
      <Text style={styles.prose} selectable>
        {question.text}
      </Text>
      {canAnswer ? (
        <View style={styles.options}>
          {question.choices.map((choice, index) => row(index, index + 1, choice.label, choice.detail, false, () => onChoose(index)))}
          {row('other', question.choices.length + 1, 'Something else…', writing ? 'answering below' : undefined, true, onWrite)}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    who: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 14, marginBottom: 2 },
    whoText: { flexShrink: 1, fontFamily: fonts.ui, fontSize: 11.5, lineHeight: 16, color: colors.inkDim },
    name: { fontFamily: fonts.uiSemibold, color: colors.ink },
    prose: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 23, color: colors.ink },
    options: { marginTop: 6, marginBottom: 4, marginHorizontal: -10 },
    option: { flexDirection: 'row', alignItems: 'baseline', gap: 12, minHeight: 40, padding: 10, borderRadius: 10 },
    key: { width: 10, fontFamily: fonts.mono, fontSize: 12, color: colors.inkFaint },
    label: { flex: 1, fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 20, color: colors.ink },
    why: { fontSize: 13, color: colors.inkDim },
    answered: { marginTop: 4, marginBottom: 8, fontFamily: fonts.ui, fontSize: 13, lineHeight: 19, color: colors.inkDim },
    answer: { color: colors.ink },
  });
