import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as ExpoDevice from 'expo-device';
import { MobileError, parsePairingLink, type PairingLink } from '@sikemux/native';

import { thisDevice } from '@/device/identity';
import { rememberMac, type Access } from '@/macs/paired';
import { colors, common } from '@/theme';

type Step =
  | { state: 'entering'; problem?: string }
  | { state: 'waiting'; link: PairingLink }
  | { state: 'failed'; message: string };

function phoneName(): string {
  return ExpoDevice.deviceName ?? ExpoDevice.modelName ?? 'Phone';
}

function pairingProblem(error: unknown): string {
  if (MobileError.WrongCode.instanceOf(error)) {
    return 'That code is not the one on the Mac. Show a new code on the Mac and scan it again.';
  }
  if (MobileError.Refused.instanceOf(error)) return error.inner.message;
  if (MobileError.Connection.instanceOf(error)) {
    return `Could not reach the Mac: ${error.inner.message}`;
  }
  return String(error);
}

function spaced(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export default function Pair() {
  const params = useLocalSearchParams<{ core?: string; code?: string }>();
  const linked = params.core && params.code ? { core: params.core, code: params.code } : undefined;
  const [step, setStep] = useState<Step>(linked ? { state: 'waiting', link: linked } : { state: 'entering' });
  const [typed, setTyped] = useState('');
  const started = useRef<string>(undefined);

  const link = step.state === 'waiting' ? step.link : undefined;
  useEffect(() => {
    if (!link) return;
    const attempt = `${link.core}/${link.code}`;
    if (started.current === attempt) return;
    started.current = attempt;
    thisDevice()
      .then((device) => device.pair(link.core, link.code, phoneName(), Platform.OS))
      .then(async (access) => {
        await rememberMac({ core: link.core, access: access as Access, pairedAt: Date.now() });
        router.replace('/');
      })
      .catch((error: unknown) => setStep({ state: 'failed', message: pairingProblem(error) }));
  }, [link]);

  const submit = () => {
    const parsed = parsePairingLink(typed.trim());
    setStep(parsed ? { state: 'waiting', link: parsed } : { state: 'entering', problem: 'That is not a Sikemux pairing link.' });
  };

  return (
    <SafeAreaView style={common.screen}>
      <View style={common.body}>
        <Text style={common.title}>Pair with a Mac</Text>
        {step.state === 'entering' && (
          <>
            <Text style={common.text}>
              On your Mac, open Settings, then Devices, and scan the QR code with your camera. Or paste the
              pairing link here.
            </Text>
            <TextInput
              style={styles.input}
              value={typed}
              onChangeText={setTyped}
              placeholder="sikemux://pair?…"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={submit}
            />
            {step.problem && <Text style={styles.problem}>{step.problem}</Text>}
            <Pressable style={common.button} onPress={submit}>
              <Text style={common.buttonText}>Pair</Text>
            </Pressable>
          </>
        )}
        {step.state === 'waiting' && (
          <>
            <Text style={common.text}>Approve this phone on your Mac.</Text>
            <Text style={common.label}>Code</Text>
            <Text style={common.key}>{spaced(step.link.code)}</Text>
          </>
        )}
        {step.state === 'failed' && (
          <>
            <Text style={styles.problem}>{step.message}</Text>
            <Pressable style={common.button} onPress={() => setStep({ state: 'entering' })}>
              <Text style={common.buttonText}>Try again</Text>
            </Pressable>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = {
  input: {
    marginTop: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
    color: colors.ink,
    fontFamily: 'Menlo',
    fontSize: 14,
  },
  problem: { color: colors.danger, fontSize: 15, lineHeight: 21, marginTop: 12 },
} as const;
