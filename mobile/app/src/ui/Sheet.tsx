import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { pauseBackdrop, useStill } from './motion';
import { fonts, type Palette, useStyles } from './theme';

const OPEN_MS = 260;
const CLOSE_MS = 180;
/** A drag past this far, or a flick faster than this, closes the sheet. */
const CLOSE_DRAG = 110;
const CLOSE_SPEED = 0.8;

/** How far the keyboard covers the screen; Android lifts a sheet above it by itself. */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (event) => setHeight(event.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

/**
 * A sheet that slides up while the screen behind it dims in place. A tap on the
 * dimmed screen or a drag down closes it. The modal stays mounted until the sheet is down.
 * Its content scrolls when it is taller than the screen, unless `scrolls` says it scrolls itself.
 */
export function Sheet({
  visible,
  onClose,
  tall,
  scrolls,
  onDismiss,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  tall?: boolean;
  scrolls?: boolean;
  /** Once the sheet is off the screen, as what it chose may need to show a screen of its own. */
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const styles = useStyles(makeStyles);
  const still = useStill();
  // A modal measures no safe area of its own, so the screen behind it lends its inset.
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  const [progress] = useState(() => new Animated.Value(0));
  const [drag] = useState(() => new Animated.Value(0));
  const [overflow, setOverflow] = useState({ content: 0, frame: 0 });
  const offscreen = Dimensions.get('window').height;

  useEffect(() => {
    if (!visible) return;
    drag.setValue(0);
    return pauseBackdrop();
  }, [visible, drag]);

  useEffect(() => {
    if (visible) {
      Animated.timing(progress, {
        toValue: 1,
        duration: still ? 0 : OPEN_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    Animated.timing(progress, { toValue: 0, duration: still ? 0 : CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(
      ({ finished }) => {
        if (finished) setMounted(false);
      },
    );
  }, [visible, progress, still]);

  const [flung, setFlung] = useState(0);
  const closeFlung = useEffectEvent(onClose);
  useEffect(() => {
    if (flung) closeFlung();
  }, [flung]);
  const [pan] = useState(() => {
    const settle = () => Animated.spring(drag, { toValue: 0, bounciness: 0, useNativeDriver: true }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 6 && gesture.dy > Math.abs(gesture.dx),
      onPanResponderMove: (_, gesture) => drag.setValue(Math.max(0, gesture.dy)),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > CLOSE_DRAG || gesture.vy > CLOSE_SPEED) {
          Keyboard.dismiss();
          setFlung((count) => count + 1);
          return;
        }
        settle();
      },
      onPanResponderTerminate: settle,
    });
  });

  const rise = progress.interpolate({ inputRange: [0, 1], outputRange: [offscreen, 0] });
  const bottom = keyboard ? keyboard + 12 : insets.bottom + 12;

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} onDismiss={onDismiss} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      </Animated.View>
      <View style={[styles.dock, { paddingTop: insets.top + 24 }]} pointerEvents="box-none">
        <Animated.View
          accessibilityViewIsModal
          {...pan.panHandlers}
          style={[
            styles.sheet,
            tall && { height: '82%' },
            { paddingBottom: bottom, transform: [{ translateY: Animated.add(rise, drag) }] },
          ]}>
          <View style={styles.handle}>
            <View style={styles.grabber} />
          </View>
          {scrolls ? (
            children
          ) : (
            <ScrollView
              style={styles.content}
              scrollEnabled={overflow.content > overflow.frame}
              alwaysBounceVertical={false}
              keyboardShouldPersistTaps="handled"
              onLayout={(event) => {
                const frame = event.nativeEvent.layout.height;
                setOverflow((was) => (was.frame === frame ? was : { ...was, frame }));
              }}
              onContentSizeChange={(_, content) => setOverflow((was) => (was.content === content ? was : { ...was, content }))}>
              {children}
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

export function SheetLabel({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.label}>{children}</Text>;
}

const makeStyles = (colors: Palette) => {
  return StyleSheet.create({
    scrim: { backgroundColor: 'rgba(9, 9, 11, 0.62)' },
    dock: { flex: 1, justifyContent: 'flex-end' },
    sheet: {
      maxHeight: '100%',
      backgroundColor: colors.overlay,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      borderTopWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    handle: { paddingTop: 8, paddingBottom: 12, alignItems: 'center' },
    grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.borderStrong },
    content: { flexGrow: 0 },
    label: { fontFamily: fonts.uiSemibold, fontSize: 13, color: colors.tertiary, paddingTop: 14, paddingBottom: 8, paddingHorizontal: 6 },
  });
};
