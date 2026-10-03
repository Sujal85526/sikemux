import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth, useUser } from '@clerk/expo';
import { nativeApplicationVersion } from 'expo-application';
import * as Updates from 'expo-updates';

import { removePhone } from '@/account/api';
import { Avatar } from '@/account/Avatar';
import { versionLabel } from '@/account/versionLabel';
import { useDeviceId } from '@/device/identity';
import { forget } from '@/devices/hub';
import { pairedDevices, shortKey } from '@/devices/paired';
import { phoneName } from '@/devices/pairing';
import { Icon } from '@/ui/Icon';
import { Button } from '@/ui/parts';
import { Sheet } from '@/ui/Sheet';
import { fonts, type Palette, typeFor, useColors, useStyles, useType } from '@/ui/theme';

const PROVIDERS: Record<string, string> = { google: 'Google', github: 'GitHub' };

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
  const provider = user?.externalAccounts[0]?.provider.replace(/^oauth_/, '');
  const name = user?.fullName?.trim() || undefined;
  const email = user?.primaryEmailAddress?.emailAddress;
  const how = provider ? `Signed in with ${PROVIDERS[provider] ?? provider}` : 'Signed in with email';

  const leave = async () => {
    setLeaving(true);
    try {
      await removePhone(() => getToken()).catch((error: unknown) => {
        console.warn('sikemux: could not take this phone off the account', error);
      });
      const devices = await pairedDevices();
      await Promise.allSettled(devices.map((device) => forget(device.core)));
      await signOut();
      onClose();
      router.replace('/');
    } finally {
      setLeaving(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
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
      <Text style={styles.note}>Signing out takes this phone off your account and forgets every host paired with it.</Text>
      <Button kind="danger" title={leaving ? 'Signing out…' : 'Sign out'} disabled={leaving} onPress={() => void leave()} />
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
    version: { ...type.meta, fontSize: 12, textAlign: 'center', paddingTop: 14 },
  });
};
