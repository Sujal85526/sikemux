import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@clerk/expo';
import * as Haptics from 'expo-haptics';

import { APPROVAL_SECONDS, expired, JoinFailed, joinHost, type JoinFailure, type JoinStep } from '@/devices/joining';
import { DeviceIcon } from '@/ui/Icon';
import { Button, Nav, Screen, useBottomGap, Working } from '@/ui/parts';
import { offerNotifications } from '@/notify/setting';
import { fonts, type Palette, radius, typeFor, useColors, useStyles, useType } from '@/ui/theme';

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function stopped(error: unknown): JoinFailure {
  if (error instanceof JoinFailed) return error.failure;
  return { title: 'Connecting stopped', detail: error instanceof Error ? error.message : String(error) };
}

/** Connects to a host on the account; someone at the host still allows it. */
export default function Join() {
  const styles = useStyles(makeStyles);
  const colors = useColors();
  const type = useType();
  const { getToken } = useAuth();
  const { core = '', name = 'your host' } = useLocalSearchParams<{ core?: string; name?: string }>();
  const [attempt, setAttempt] = useState(0);
  const [step, setStep] = useState<JoinStep>('asking');
  const [failed, setFailed] = useState<JoinFailure>();
  const [left, setLeft] = useState(APPROVAL_SECONDS);
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
    joinHost({ core, name }, () => tokenRef.current(), setStep, controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/device/${core}`);
        offerNotifications().catch(() => {});
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailed(stopped(error));
      });
    return () => controller.abort();
  }, [core, name, attempt]);

  const waiting = step === 'waiting' && !problem;
  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => setLeft((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(tick);
  }, [waiting]);

  useEffect(() => {
    if (left === 0) joining.current?.abort();
  }, [left]);

  const retry = () => {
    setFailed(undefined);
    setLeft(APPROVAL_SECONDS);
    setStep('asking');
    setAttempt((count) => count + 1);
  };

  const leave = () => {
    joining.current?.abort();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const bottom = useBottomGap();
  return (
    <Screen>
      <Nav back={problem ? 'Back' : 'Cancel'} onBack={leave} />
      <View style={styles.block}>
        <Text style={styles.title}>{problem ? problem.title : `Allow this phone on ${name}`}</Text>
        <Text style={styles.detail}>
          {problem ? problem.detail : `On ${name}, choose whether to let this phone in, and with what access.`}
        </Text>
        <View style={[styles.glyph, problem && styles.glyphFailed]}>
          <DeviceIcon kind="laptop" size={34} color={problem ? '#f3a7ab' : colors.ink} />
        </View>
      </View>
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
    glyphFailed: { borderColor: 'rgba(255, 103, 103, 0.55)', backgroundColor: '#140b0d' },
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
