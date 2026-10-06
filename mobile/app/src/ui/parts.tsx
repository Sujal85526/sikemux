import { useEffect, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Backdrop } from './Backdrop';
import { goBack } from './navigate';
import { useStill } from './motion';
import { DrawnIcon, Icon } from './Icon';
import { fonts, keyboardFor, type Palette, radius, typeFor, useColors, useStyles, translucent } from './theme';

/** Space under a screen's last content: the system's home bar or gesture bar, then a little air. */
export function useBottomGap(): number {
  return useSafeAreaInsets().bottom + 12;
}

/** Whether the keyboard is up; it covers the home bar, so screens drop that gap while it is. */
export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(Keyboard.isVisible());
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return (
    <SafeAreaView style={[styles.screen, style]} edges={['top', 'left', 'right']}>
      <Backdrop />
      {children}
    </SafeAreaView>
  );
}

export function Nav({ back, title, end, onBack }: { back?: string; title?: ReactNode; end?: ReactNode; onBack?: () => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.nav}>
      <Pressable style={styles.back} onPress={onBack ?? goBack} hitSlop={8} accessibilityRole="button" accessibilityLabel={back ?? 'Back'}>
        <View style={styles.backChevron}>
          <Icon name="IconChevron" size={18} color={colors.secondary} />
        </View>
        {back ? <Text style={styles.backText}>{back}</Text> : null}
      </Pressable>
      <View style={styles.navTitle}>
        {typeof title === 'string' ? (
          <Text style={styles.navTitleText} numberOfLines={1}>
            {title}
          </Text>
        ) : (
          title
        )}
      </View>
      <View style={styles.navEnd}>{end}</View>
    </View>
  );
}

export function IconButton({ name, onPress, label }: { name: Parameters<typeof Icon>[0]['name']; onPress?: () => void; label: string }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable style={styles.iconButton} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <Icon name={name} size={18} color={colors.tertiary} />
    </Pressable>
  );
}

type ButtonKind = 'primary' | 'neutral' | 'danger' | 'text';

export function Button({
  title,
  onPress,
  kind = 'neutral',
  disabled,
  icon,
  style,
}: {
  title: string;
  onPress?: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  /** Drawn before the title, such as a sign-in provider's logo. */
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles);
  const fill = useStyles(buttonFill);
  const ink = useStyles(buttonInk);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.button, fill[kind], pressed && styles.pressed, disabled && styles.disabled, style]}>
      {icon}
      <Text style={[styles.buttonText, ink[kind]]}>{title}</Text>
    </Pressable>
  );
}

/** A text box in the app's controls: sunken, rounded, edged in the accent while typing in it. */
export function Field(props: TextInputProps) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={colors.tertiary}
      selectionColor={colors.accent}
      keyboardAppearance={keyboardFor(colors)}
      {...props}
      onFocus={(event) => {
        setFocused(true);
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        props.onBlur?.(event);
      }}
      style={[styles.field, focused && styles.fieldFocused, props.style]}
    />
  );
}

export function PasswordField(props: Omit<TextInputProps, 'secureTextEntry'>) {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  const [shown, setShown] = useState(false);
  return (
    <View>
      <Field {...props} secureTextEntry={!shown} style={[styles.passwordField, props.style]} />
      <Pressable
        onPress={() => setShown((was) => !was)}
        style={styles.reveal}
        accessibilityRole="button"
        accessibilityLabel={shown ? 'Hide password' : 'Show password'}
        hitSlop={6}>
        {shown ? <DrawnIcon name="eyeOff" size={18} color={colors.tertiary} /> : <Icon name="IconEye" size={18} color={colors.tertiary} />}
      </Pressable>
    </View>
  );
}

/** A list's small-caps label, with a hairline running to the right as on the Mac's rail. */
export function SectionLabel({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.sectionLabel}>
      <Text style={styles.sectionLabelText}>{children}</Text>
      <View style={styles.sectionRule} />
    </View>
  );
}

/** Rows straight on the ground, a little apart, the way the Mac's rail lists agents. */
export function Rows({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.rows, style]}>{children}</View>;
}

export function Row({
  mark,
  title,
  detail,
  end,
  onPress,
  dim,
  bright,
}: {
  mark?: ReactNode;
  title: string;
  detail?: ReactNode;
  end?: ReactNode;
  onPress?: () => void;
  dim?: boolean;
  /** Titles the row in full ink, for the one that is waiting on the person. */
  bright?: boolean;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => [styles.row, pressed && onPress && styles.rowPressed]}>
      {mark ? <View style={styles.mark}>{mark}</View> : null}
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: dim ? colors.tertiary : bright ? colors.ink : colors.secondary }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={styles.rowDetail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {end ? <View style={styles.rowEnd}>{end}</View> : null}
    </Pressable>
  );
}

/** The rail's scope track: two or three options, the chosen one lifted. */
export function Track<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.track} accessibilityRole="tablist">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.trackOption, on && styles.trackOn]}
            hitSlop={{ top: 4, bottom: 4 }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}>
            <Text style={[styles.trackText, on && { color: colors.ink }]}>{option.label}</Text>
            {option.count ? (
              <View style={styles.count}>
                <Text style={styles.countText} maxFontSizeMultiplier={1.3}>
                  {option.count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function useLoop(still: boolean, duration: number, delay = 0) {
  const [value] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (still) {
      value.setValue(0);
      return;
    }
    // A delay inside a native-driven loop stops the loop after its first run, so the offset is waited once.
    const loop = Animated.sequence([
      Animated.delay(delay),
      Animated.loop(Animated.timing(value, { toValue: 1, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true })),
    ]);
    loop.start();
    return () => loop.stop();
  }, [value, duration, delay, still]);
  return value;
}

const TWINKLE = [1200, 1580, 900, 1400, 1050, 1300, 950, 1500, 1150];

function TwinkleCell({ period, index, still }: { period: number; index: number; still: boolean }) {
  const styles = useStyles(makeStyles);
  const phase = useLoop(still, period, (index * 230) % period);
  const opacity = phase.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.2, 1, 0.2] });
  return <Animated.View style={[styles.cell, { opacity }]} />;
}

/** An agent at work: the rail's three-by-three twinkling squares. */
export function Working() {
  const styles = useStyles(makeStyles);
  const still = useStill();
  return (
    <View style={styles.loader} accessible accessibilityLabel="Working">
      {TWINKLE.map((period, index) => (
        <TwinkleCell key={index} period={period} index={index} still={still} />
      ))}
    </View>
  );
}

/** Something is waiting on the person: a white dot sending out a ring. */
export function NeedsYou() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const still = useStill();
  const phase = useLoop(still, 2000);
  const scale = phase.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.8] });
  const opacity = phase.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] });
  return (
    <View style={styles.dotBox} accessible accessibilityLabel="Needs input">
      <Animated.View style={[styles.ring, { transform: [{ scale }], opacity }]} />
      <View style={[styles.dot, { backgroundColor: colors.ink }]} />
    </View>
  );
}

export function Dot({ color, size = 8, hollow }: { color: string; size?: number; hollow?: boolean }) {
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: size },
        hollow ? { borderWidth: 1.5, borderColor: color } : { backgroundColor: color },
      ]}
    />
  );
}

const buttonFill = (colors: Palette): Record<ButtonKind, ViewStyle> => ({
  primary: { backgroundColor: colors.ink, borderColor: colors.ink },
  neutral: { backgroundColor: colors.raised, borderColor: colors.border },
  danger: { backgroundColor: colors.raised, borderColor: colors.border },
  text: { backgroundColor: 'transparent', borderColor: 'transparent', minHeight: 44 },
});

const buttonInk = (colors: Palette): Record<ButtonKind, TextStyle> => ({
  primary: { color: colors.ground },
  neutral: { color: colors.ink },
  danger: { color: colors.danger },
  text: { color: colors.secondary, fontFamily: fonts.uiMedium },
});

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.ground },
    nav: { minHeight: 46, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 },
    back: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingRight: 8, paddingLeft: 4, minWidth: 44 },
    backChevron: { transform: [{ rotate: '180deg' }] },
    backText: { fontFamily: fonts.ui, fontSize: 16, color: colors.secondary, marginLeft: 2 },
    navTitle: { flex: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
    navTitleText: { fontFamily: fonts.uiSemibold, fontSize: 16, letterSpacing: -0.25, color: colors.ink },
    navEnd: { minWidth: 76, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
    iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },

    button: {
      minHeight: 50,
      paddingVertical: 8,
      borderRadius: radius.row,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 10,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    buttonText: { fontFamily: fonts.uiSemibold, fontSize: 16 },
    field: {
      height: 50,
      borderRadius: radius.row,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.sunken,
      paddingHorizontal: 14,
      fontFamily: fonts.ui,
      fontSize: 16,
      color: colors.ink,
    },
    fieldFocused: { borderColor: colors.borderSelected },
    passwordField: { paddingRight: 48 },
    reveal: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 48, alignItems: 'center', justifyContent: 'center' },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.5 },

    sectionLabel: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 18, paddingBottom: 6, paddingHorizontal: 8 },
    sectionLabelText: { fontFamily: fonts.uiMedium, fontSize: 11, letterSpacing: 1.76, textTransform: 'uppercase', color: colors.tertiary },
    sectionRule: { flex: 1, height: 1, backgroundColor: translucent(colors.ink, 0.09) },
    rows: { gap: 2 },
    row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 9 },
    rowPressed: { backgroundColor: colors.active },
    mark: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
    rowBody: { flex: 1, minWidth: 0 },
    rowTitle: { ...type.row, fontSize: 14.5 },
    rowDetail: { ...type.meta, fontSize: 12, marginTop: 1 },
    rowEnd: { minWidth: 20, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },

    track: {
      minHeight: 36,
      padding: 3,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: translucent(colors.raised, 0.8),
      flexDirection: 'row',
    },
    trackOption: { flex: 1, borderRadius: 7, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
    trackOn: { backgroundColor: colors.active },
    trackText: { fontFamily: fonts.ui, fontSize: 13, color: colors.tertiary },
    count: {
      minWidth: 16,
      minHeight: 16,
      borderRadius: 8,
      paddingHorizontal: 5,
      backgroundColor: colors.ink,
      alignItems: 'center',
      justifyContent: 'center',
    },
    countText: { fontFamily: fonts.uiSemibold, fontSize: 11, color: colors.ground },

    loader: { width: 13, height: 13, flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
    cell: { width: 3, height: 3, borderRadius: 0.6, backgroundColor: colors.live },
    dotBox: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
    ring: { position: 'absolute', width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: colors.ink },
    dot: { width: 8, height: 8, borderRadius: 4 },
  });
};
