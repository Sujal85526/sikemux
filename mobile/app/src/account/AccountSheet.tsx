import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth, useUser } from '@clerk/expo';
import { nativeApplicationVersion } from 'expo-application';
import * as Updates from 'expo-updates';

import { AccountProblem, removePhone } from '@/account/api';
import { Avatar } from '@/account/Avatar';
import { providerName } from '@/account/providers';
import { signOutHere } from '@/account/leave';
import { versionLabel } from '@/account/versionLabel';
import { useDeviceId } from '@/device/identity';
import { shortKey } from '@/devices/paired';
import { phoneName } from '@/device/name';
import { NotificationsRow } from '@/notify/NotificationsRow';
import { stopPush } from '@/notify/token';
import { Icon } from '@/ui/Icon';
import { Button } from '@/ui/parts';
import { Sheet } from '@/ui/Sheet';
import { fonts, type Palette, typeFor, useColors, useStyles, useType } from '@/ui/theme';

const VERSION = versionLabel(nativeApplicationVersion, {
  id: Updates.updateId,
  createdAt: Updates.createdAt,
  embedded: Updates.isEmbeddedLaunch,
});

/** Who is signed in, this phone as the account knows it, and signing out. */
export function AccountSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const type = useType();
  const { signOut, getToken } = useAuth();
  const { user } = useUser();
  const id = useDeviceId();
  const [leaving, setLeaving] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [problem, setProblem] = useState<string>();
  const provider = providerName(user?.externalAccounts[0]?.provider);
  const name = user?.fullName?.trim() || undefined;
  const email = user?.primaryEmailAddress?.emailAddress;
  const how = `Signed in with ${provider ?? 'email'}`;

  /** Takes the notification token and then the phone off the account first, so hosts hear of it; offline, it asks before leaving them there. */
  const leave = async (anyway = false) => {
    setLeaving(true);
    setUnreachable(false);
    setProblem(undefined);
    try {
      if (!anyway) {
        await stopPush(() => getToken());
        await removePhone(() => getToken());
      }
    } catch (error) {
      setLeaving(false);
      if (error instanceof AccountProblem && !error.unreachable) setProblem(error.message);
      else setUnreachable(true);
      return;
    }
    try {
      await signOutHere(() => signOut());
      onClose();
    } finally {
      setLeaving(false);
    }
  };

  const close = () => {
    setUnreachable(false);
    setProblem(undefined);
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={close}>
      <View style={styles.head}>
        <Avatar size={44} />
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {name ?? email ?? 'Signed in'}
          </Text>
          {name && email ? (
            <Text style={type.meta} numberOfLines={1}>
              {email}
            </Text>
          ) : null}
          <Text style={type.meta}>{how}</Text>
        </View>
      </View>
      <View style={styles.phone}>
        <Icon name="IconPhone" size={18} color={colors.secondary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.phoneName}>{phoneName()}</Text>
          <Text style={type.meta}>
            This phone{id ? ' · ' : ''}
            {id ? <Text style={type.mono}>{shortKey(id)}</Text> : null}
          </Text>
        </View>
      </View>
      <NotificationsRow />
      {unreachable ? (
        <>
          <Text style={styles.noteTitle}>Can&apos;t reach Sikemux</Text>
          <Text style={[styles.note, styles.noteAfterTitle]}>
            Signing out now leaves this phone on your account until you remove it at app.sikemux.com.
          </Text>
          <View style={styles.choices}>
            <Button title="Try again" disabled={leaving} onPress={() => void leave()} />
            <Button
              kind="danger"
              title={leaving ? 'Signing out…' : 'Sign out anyway'}
              disabled={leaving}
              onPress={() => void leave(true)}
            />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.note}>Signing out takes this phone off your account and forgets every host paired with it.</Text>
          {problem ? <Text style={styles.problem}>{problem}</Text> : null}
          <Button kind="danger" title={leaving ? 'Signing out…' : 'Sign out'} disabled={leaving} onPress={() => void leave()} />
        </>
      )}
      <Pressable
        onPress={() => {
          close();
          router.push('/delete-account');
        }}
        disabled={leaving}
        style={styles.link}
        accessibilityRole="button">
        <Text style={styles.linkText}>Delete account…</Text>
      </Pressable>
      <Text style={styles.version}>Sikemux {VERSION}</Text>
    </Sheet>
  );
}

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 14 },
    name: { fontFamily: fonts.uiSemibold, fontSize: 16, letterSpacing: -0.25, color: colors.ink },
    phone: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 52,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.raised,
    },
    phoneName: { ...type.row, fontSize: 15, color: colors.ink },
    note: { ...type.meta, lineHeight: 19, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 12 },
    noteTitle: { fontFamily: fonts.uiSemibold, fontSize: 15, color: colors.ink, paddingHorizontal: 8, paddingTop: 12 },
    noteAfterTitle: { paddingTop: 4 },
    problem: { ...type.meta, color: colors.danger, paddingHorizontal: 8, paddingBottom: 12 },
    choices: { gap: 8 },
    link: { height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
    linkText: { fontFamily: fonts.uiMedium, fontSize: 15, color: colors.secondary },
    version: { ...type.meta, fontSize: 12, textAlign: 'center', paddingTop: 14 },
  });
};
