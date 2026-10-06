import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Easing, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@clerk/expo';

import { APPROVAL_SECONDS, expired, JoinFailed, joinHost, useJoinScreen, type JoinFailure, type JoinStep } from '@/devices/joining';
import { useStill } from '@/ui/motion';
import { DeviceIcon, Icon } from '@/ui/Icon';
import { haptics } from '@/ui/haptics';
import { goBack } from '@/ui/navigate';
import { Button, Nav, Screen, useBottomGap, Working } from '@/ui/parts';
import { offerNotifications } from '@/notify/setting';
import { fonts, type Palette, radius, translucent, typeFor, useColors, useStyles, useType } from '@/ui/theme';

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const LINE = 84;
const DOT = 6;

/** This phone and the host, with the live dot travelling between them while the host decides. */
function Handshake() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const still = useStill();
  const [travel] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (still) {
      travel.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(travel, { toValue: 1, duration: 1600, easing: Easing.bezier(0.5, 0, 0.5, 1), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [travel, still]);
  const translateX = travel.interpolate({ inputRange: [0, 1], outputRange: [0, LINE - DOT] });
  return (
    <View style={styles.handshake} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.end}>
        <Icon name="IconPhone" size={30} color={colors.ink} />
      </View>
      <View style={styles.line}>
        {Array.from({ length: LINE / DOT }, (_, index) => (
          <View key={index} style={styles.dash} />
        ))}
        <Animated.View style={[styles.travel, { transform: [{ translateX }] }]} />
      </View>
      <View style={styles.end}>
        <DeviceIcon kind="laptop" size={30} color={colors.ink} />
      </View>
    </View>
  );
}

function stopped(error: unknown): JoinFailure {
  if (error instanceof JoinFailed) return error.failure;
  return { title: 'Connecting stopped', detail: error instanceof Error ? error.message : String(error) };
}

/** Connects to a host on the account; someone at the host still allows it. `arrived` marks a host that just signed in. */
export { Crashed as ErrorBoundary } from '@/screens/Crashed';

export default function Join() {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  const type = useType();
  const { getToken } = useAuth();
  const { core = '', name = 'your host', arrived } = useLocalSearchParams<{ core?: string; name?: string; arrived?: string }>();
  useJoinScreen();
  const [attempt, setAttempt] = useState(0);
  const [step, setStep] = useState<JoinStep>('asking');
  const [failed, setFailed] = useState<JoinFailure>();
  const [deadline, setDeadline] = useState<number>();
  const [now, setNow] = useState(() => Date.now());
  const left = deadline === undefined ? APPROVAL_SECONDS : Math.max(0, Math.ceil((deadline - now) / 1000));
  const joining = useRef<AbortController>(undefined);
  const tokenRef = useRef(getToken);
  useEffect(() => {
    tokenRef.current = getToken;
  });
  const problem = failed ?? (left === 0 ? expired(name) : undefined);

  useEffect(() => {
    if (!core) return;
    const controller = new AbortController();
    joining.current = controller;
    const stepTo = (next: JoinStep) => {
      setStep(next);
      if (next !== 'waiting') return;
      const at = Date.now();
      setNow(at);
      setDeadline(at + APPROVAL_SECONDS * 1000);
    };
    joinHost({ core, name }, () => tokenRef.current(), stepTo, controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        haptics.success();
        router.replace(`/device/${core}`);
        offerNotifications().catch(() => {});
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        haptics.failure();
        setFailed(stopped(error));
      });
    return () => controller.abort();
  }, [core, name, attempt]);

  const waiting = step === 'waiting' && !problem;
  // Counted from the deadline, so time spent in another app still counts.
  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const back = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(Date.now());
    });
    return () => {
      clearInterval(tick);
      back.remove();
    };
  }, [waiting]);

  useEffect(() => {
    if (left === 0) joining.current?.abort();
  }, [left]);

  const retry = () => {
    setFailed(undefined);
    setDeadline(undefined);
    setStep('asking');
    setAttempt((count) => count + 1);
  };

  const leave = () => {
    joining.current?.abort();
    goBack();
  };

  const bottom = useBottomGap();
  return (
    <Screen>
      <Nav back={problem ? 'Back' : 'Cancel'} onBack={leave} />
      {arrived && !problem ? (
        <View style={styles.found}>
          <Handshake />
          <Text style={styles.foundTitle}>{name} just signed in</Text>
          <Text style={styles.foundDetail}>
            Click <Text style={styles.strong}>Allow</Text> on {name} to let this phone in.
          </Text>
        </View>
      ) : (
        <View style={styles.block}>
          <Text style={styles.title}>{problem ? problem.title : `Allow this phone on ${name}`}</Text>
          <Text style={styles.detail}>
            {problem ? problem.detail : `On ${name}, choose whether to let this phone in, and with what access.`}
          </Text>
          <View style={[styles.glyph, problem && styles.glyphFailed]}>
            <DeviceIcon kind="laptop" size={34} color={problem ? colors.danger : colors.ink} />
          </View>
        </View>
      )}
      <View style={[styles.footer, { paddingBottom: bottom }]}>
        {problem ? (
          <Button kind="primary" title="Try again" onPress={retry} />
        ) : (
          <View style={styles.waiting}>
            <Working />
            <Text style={styles.waitingText} numberOfLines={1}>
              {waiting ? `Waiting for ${name}` : `Reaching ${name}`}
            </Text>
            {waiting ? <Text style={type.mono}>{clock(left)}</Text> : null}
          </View>
        )}
      </View>
    </Screen>
  );
}

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    block: { flex: 1, paddingTop: 40, paddingHorizontal: 28, alignItems: 'center' },
    title: { ...type.title, fontSize: 22, textAlign: 'center' },
    detail: { ...type.body, textAlign: 'center', marginTop: 8, minHeight: 44 },
    glyph: {
      marginTop: 32,
      width: 76,
      height: 76,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.raised,
    },
    found: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 },
    foundTitle: { ...type.title, fontSize: 25, lineHeight: 29, letterSpacing: -0.75, textAlign: 'center', marginTop: 28 },
    foundDetail: { ...type.body, textAlign: 'center', marginTop: 10 },
    strong: { fontFamily: fonts.uiSemibold, color: colors.ink },
    handshake: { flexDirection: 'row', alignItems: 'center' },
    end: {
      width: 64,
      height: 64,
      borderRadius: radius.card,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.raised,
    },
    line: { width: LINE, height: 2, marginHorizontal: 6, flexDirection: 'row', justifyContent: 'space-between' },
    dash: { width: DOT / 2, height: 2, backgroundColor: colors.rest },
    travel: {
      position: 'absolute',
      left: 0,
      top: -2,
      width: DOT,
      height: DOT,
      borderRadius: DOT / 2,
      backgroundColor: colors.live,
      shadowColor: colors.live,
      shadowOpacity: 1,
      shadowRadius: 5,
      shadowOffset: { width: 0, height: 0 },
    },
    glyphFailed: { borderColor: translucent(colors.danger, 0.55), backgroundColor: translucent(colors.danger, 0.08) },
    footer: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
    waiting: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      borderRadius: radius.row,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.raised,
    },
    waitingText: { flex: 1, fontFamily: fonts.ui, fontSize: 15, color: colors.secondary },
  });
};
