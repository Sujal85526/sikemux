import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useAuth } from '@clerk/expo';
import type { PendingHost } from '@protocol';

import { platformName } from '@mac/remote/access';
import { approveHost, pendingHost, refuseHost } from '@/account/api';
import { retryHosts } from '@/account/session';
import { haptics } from '@/ui/haptics';
import { DeviceIcon } from '@/ui/Icon';
import { Button, Field } from '@/ui/controls';
import { goBack } from '@/ui/navigate';
import { Nav, Screen, useBottomGap } from '@/ui/screen';
import { type Palette, typeFor, useStyles } from '@/ui/theme';

type Step = { kind: 'enter' } | { kind: 'check'; code: string; host: PendingHost } | { kind: 'done'; name: string; added: boolean };

/** Signs in a host with no browser: the person types the code `sikemux core sign-in` shows there, checks the host and adds it. */
export default function HostSignIn() {
  const styles = useStyles(makeStyles);
  const bottom = useBottomGap();
  const { getToken } = useAuth();
  const { code: given } = useLocalSearchParams<{ code?: string }>();
  const [typed, setTyped] = useState(given ?? '');
  const [step, setStep] = useState<Step>({ kind: 'enter' });
  const [busy, setBusy] = useState<'look' | 'add' | 'refuse' | undefined>(given ? 'look' : undefined);
  const [problem, setProblem] = useState<string>();
  const token = () => getToken();

  const run = async (action: 'look' | 'add' | 'refuse', work: () => Promise<Step>) => {
    setBusy(action);
    setProblem(undefined);
    try {
      setStep(await work());
      haptics.success();
    } catch (error) {
      haptics.failure();
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  };
  const look = (code: string) => run('look', async () => ({ kind: 'check', code, host: await pendingHost(token, code) }));

  useEffect(() => {
    if (!given) return;
    let current = true;
    pendingHost(() => getToken(), given)
      .then(
        (host) => current && setStep({ kind: 'check', code: given, host }),
        (error: unknown) => current && setProblem(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => current && setBusy(undefined));
    return () => {
      current = false;
    };
  }, [given, getToken]);

  if (step.kind === 'done')
    return (
      <Screen>
        <Nav back="Devices" />
        <View style={styles.block}>
          <Text style={styles.title}>{step.added ? `${step.name} is on your account` : 'Refused'}</Text>
          <Text style={styles.detail}>
            {step.added
              ? 'It finishes signing in by itself. Connect to it from Devices; it still asks before it lets each phone in.'
              : `${step.name} was not added, and its sign-in has stopped.`}
          </Text>
          <Button title="Done" onPress={goBack} style={styles.action} />
        </View>
      </Screen>
    );

  if (step.kind === 'check') {
    const { code, host } = step;
    return (
      <Screen>
        <Nav back="Back" onBack={() => setStep({ kind: 'enter' })} />
        <ScrollView contentContainerStyle={[styles.block, { paddingBottom: bottom }]}>
          <View style={styles.glyph}>
            <DeviceIcon kind={host.platform === 'linux' ? 'desktop' : 'laptop'} size={34} />
          </View>
          <Text style={styles.title}>Add {host.name} to your account?</Text>
          <Text style={styles.detail}>
            {platformName(host.platform)} · {host.channel}. Only add a computer you are setting up yourself right now: phones on your
            account will find it and can ask to join it.
          </Text>
          {problem ? <Text style={styles.problem}>{problem}</Text> : null}
          <Button
            kind="primary"
            title="Add host"
            busy={busy === 'add'}
            disabled={busy !== undefined}
            onPress={() =>
              void run('add', async () => {
                await approveHost(token, code);
                retryHosts();
                return { kind: 'done', name: host.name, added: true };
              })
            }
            style={styles.action}
          />
          <Button
            kind="danger"
            title="Not mine"
            busy={busy === 'refuse'}
            disabled={busy !== undefined}
            onPress={() =>
              void run('refuse', async () => {
                await refuseHost(token, code);
                return { kind: 'done', name: host.name, added: false };
              })
            }
          />
        </ScrollView>
      </Screen>
    );
  }

  const entered = typed.trim();
  return (
    <Screen>
      <Nav back="Devices" />
      <ScrollView contentContainerStyle={[styles.block, { paddingBottom: bottom }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Add a host with a code</Text>
        <Text style={styles.detail}>
          Enter the code <Text style={styles.mono}>sikemux core sign-in</Text> shows on the computer.
        </Text>
        <Field
          value={typed}
          onChangeText={setTyped}
          placeholder="BCDF-GHJK"
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          autoFocus={!given}
          returnKeyType="go"
          onSubmitEditing={() => entered && void look(entered)}
          accessibilityLabel="Code"
          style={styles.code}
        />
        {problem ? <Text style={styles.problem}>{problem}</Text> : null}
        <Button
          kind="primary"
          title="Continue"
          busy={busy === 'look'}
          disabled={!entered || busy !== undefined}
          onPress={() => void look(entered)}
          style={styles.action}
        />
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    block: { paddingHorizontal: 20, paddingTop: 12, gap: 12 },
    glyph: { paddingBottom: 4 },
    title: { ...type.title, fontSize: 24 },
    detail: { ...type.body },
    mono: { ...type.mono, color: colors.ink },
    code: { ...type.mono, fontSize: 20, letterSpacing: 2, color: colors.ink },
    problem: { ...type.meta, fontSize: 13.5, color: colors.danger },
    action: { marginTop: 8 },
  });
};
