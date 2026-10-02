import { useRef } from 'react';
import { Pressable, StyleSheet, TextInput } from 'react-native';

import { CodeTiles } from './parts';

/** Six code tiles over a hidden number field, so the system keyboard fills them one by one. */
export function CodeEntry({
  code,
  onChange,
  failed,
  disabled,
}: {
  code: string;
  onChange: (code: string) => void;
  failed?: boolean;
  disabled?: boolean;
}) {
  const input = useRef<TextInput>(null);
  return (
    <Pressable onPress={() => input.current?.focus()} accessibilityRole="none">
      <CodeTiles code={code} state={failed ? 'failed' : disabled ? 'locked' : 'typing'} />
      <TextInput
        ref={input}
        value={code}
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, 6))}
        editable={!disabled}
        autoFocus
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={6}
        caretHidden
        style={styles.hidden}
        accessibilityLabel="Code"
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', opacity: 0, width: 1, height: 1 },
});
