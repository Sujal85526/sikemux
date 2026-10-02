import { Children, useEffect, useRef, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { Backdrop } from './Backdrop';
import { Icon } from './Icon';
import { fonts, type Palette, radius, typeFor, useColors, useStyles, useType } from './theme';

/** Space under a screen's last content: the system's home bar or gesture bar, then a little air. */
export function useBottomGap(): number {
  return useSafeAreaInsets().bottom + 12;
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

export function Nav({ back, title, end }: { back?: string; title?: ReactNode; end?: ReactNode }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.nav}>
      <Pressable style={styles.back} onPress={() => router.back()} hitSlop={8} accessibilityRole="button">
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
  style,
}: {
  title: string;
  onPress?: () => void;
  kind?: ButtonKind;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles(makeStyles);
  const fill = useStyles(buttonFill);
  const ink = useStyles(buttonInk);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, fill[kind], pressed && styles.pressed, style]}>
      <Text style={[styles.buttonText, ink[kind]]}>{title}</Text>
    </Pressable>
  );
}

export function SectionLabel({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

/** Rows in one rounded group, divided by an inset hairline. */
export function Group({ children, inset = 50 }: { children: ReactNode; inset?: number }) {
  const styles = useStyles(makeStyles);
  const rows = Children.toArray(children);
  return (
    <View style={styles.group}>
      {rows.map((row, index) => (
        <View key={index}>
          {index > 0 ? <View style={[styles.divider, { marginLeft: inset }]} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

export function Row({
  mark,
  title,
  detail,
  end,
  onPress,
  dim,
  selected,
}: {
  mark?: ReactNode;
  title: string;
  detail?: ReactNode;
  end?: ReactNode;
  onPress?: () => void;
  dim?: boolean;
  selected?: boolean;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const type = useType();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && onPress && styles.rowPressed]}>
      {mark ? <View style={styles.mark}>{mark}</View> : null}
      <View style={styles.rowBody}>
        <Text style={[type.row, { color: dim ? colors.tertiary : selected ? colors.ink : colors.secondary }]} numberOfLines={1}>
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

export function Mono({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const type = useType();
  return <Text style={[type.mono, style as object]}>{children}</Text>;
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
    <View style={styles.track}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.trackOption, on && styles.trackOn]}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}>
            <Text style={[styles.trackText, on && { color: colors.ink }]}>{option.label}</Text>
            {option.count ? (
              <View style={styles.count}>
                <Text style={styles.countText}>{option.count}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function useReducedMotion() {
  const reduced = useRef(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      reduced.current = value;
    });
  }, []);
  return reduced;
}

function useLoop(duration: number, delay = 0) {
  const value = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced.current) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(value, { toValue: 1, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value, duration, delay, reduced]);
  return value;
}

const TWINKLE = [1200, 1580, 900, 1400, 1050, 1300, 950, 1500, 1150];

function TwinkleCell({ period, index }: { period: number; index: number }) {
  const styles = useStyles(makeStyles);
  const phase = useLoop(period, (index * 230) % period);
  const opacity = phase.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.2, 1, 0.2] });
  return <Animated.View style={[styles.cell, { opacity }]} />;
}

/** An agent at work: the rail's three-by-three twinkling squares. */
export function Working() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.loader}>
      {TWINKLE.map((period, index) => (
        <TwinkleCell key={index} period={period} index={index} />
      ))}
    </View>
  );
}

/** Something is waiting on the person: a white dot sending out a ring. */
export function NeedsYou() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const phase = useLoop(2000);
  const scale = phase.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.8] });
  const opacity = phase.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] });
  return (
    <View style={styles.dotBox}>
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

export function CodeTiles({ code, state = 'typing' }: { code: string; state?: 'typing' | 'locked' | 'failed' }) {
  const styles = useStyles(makeStyles);
  const digits = Array.from({ length: 6 }, (_, index) => code[index] ?? '');
  const current = code.length;
  return (
    <View style={styles.tiles}>
      {digits.map((digit, index) => (
        <View key={index} style={[styles.tileWrap, index === 3 && { marginLeft: 6 }]}>
          <View
            style={[
              styles.tile,
              state === 'typing' && index === current && styles.tileCurrent,
              state === 'locked' && styles.tileLocked,
              state === 'failed' && styles.tileFailed,
            ]}>
            <Text style={[styles.tileText, state === 'failed' && { color: '#f3a7ab' }]}>{digit}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const buttonFill = (colors: Palette): Record<ButtonKind, ViewStyle> => ({
  primary: { backgroundColor: colors.ink, borderColor: colors.ink },
  neutral: { backgroundColor: colors.raised, borderColor: colors.border },
  danger: { backgroundColor: colors.raised, borderColor: colors.border },
  text: { backgroundColor: 'transparent', borderColor: 'transparent', height: 40 },
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
    nav: { height: 46, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 },
    back: { flexDirection: 'row', alignItems: 'center', height: 44, paddingRight: 8, paddingLeft: 4, minWidth: 44 },
    backChevron: { transform: [{ rotate: '180deg' }] },
    backText: { fontFamily: fonts.ui, fontSize: 16, color: colors.secondary, marginLeft: 2 },
    navTitle: { flex: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
    navTitleText: { fontFamily: fonts.uiSemibold, fontSize: 16, letterSpacing: -0.25, color: colors.ink },
    navEnd: { minWidth: 76, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
    iconButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },

    button: { height: 50, borderRadius: radius.row, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
    buttonText: { fontFamily: fonts.uiSemibold, fontSize: 16 },
    pressed: { opacity: 0.75 },

    sectionLabel: { ...type.label, paddingTop: 20, paddingBottom: 8, paddingHorizontal: 6 },
    group: { borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, overflow: 'hidden' },
    divider: { height: StyleSheet.hairlineWidth * 2, backgroundColor: colors.border },
    row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 8 },
    rowSelected: { backgroundColor: colors.active },
    rowPressed: { backgroundColor: colors.active },
    mark: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
    rowBody: { flex: 1, minWidth: 0 },
    rowDetail: { ...type.meta, fontSize: 12.5, marginTop: 1 },
    rowEnd: { minWidth: 20, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },

    track: { height: 36, padding: 3, borderRadius: 10, borderWidth: 1, borderColor: colors.border, flexDirection: 'row' },
    trackOption: { flex: 1, borderRadius: 7, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
    trackOn: { backgroundColor: colors.active },
    trackText: { fontFamily: fonts.ui, fontSize: 13, color: colors.tertiary },
    count: { minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 5, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
    countText: { fontFamily: fonts.uiSemibold, fontSize: 11, color: colors.ground },

    loader: { width: 13, height: 13, flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
    cell: { width: 3, height: 3, borderRadius: 0.6, backgroundColor: colors.live },
    dotBox: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
    ring: { position: 'absolute', width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: colors.ink },
    dot: { width: 8, height: 8, borderRadius: 4 },

    tiles: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
    tileWrap: {},
    tile: { width: 46, height: 58, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.sunken, alignItems: 'center', justifyContent: 'center' },
    tileCurrent: { borderColor: colors.borderSelected },
    tileLocked: { backgroundColor: colors.raised, borderColor: colors.borderStrong },
    tileFailed: { borderColor: 'rgba(255, 103, 103, 0.55)', backgroundColor: '#140b0d' },
    tileText: { fontFamily: fonts.mono, fontSize: 26, color: colors.ink },
  });
};
