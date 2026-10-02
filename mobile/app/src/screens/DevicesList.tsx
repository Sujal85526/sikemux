import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useUser } from '@clerk/expo';
import type { Device } from '@protocol';

import { AccountSheet } from '@/account/AccountSheet';
import { useAccountMacs } from '@/account/session';
import { pasteFoundLink } from '@/devices/foundLinks';

import type { Snapshot } from '@/core/protocol';
import { useLive } from '@/devices/hub';
import { channelLabel, deviceKind, deviceName, type PairedDevice } from '@/devices/paired';
import { chatTitle, ago } from '@/devices/words';
import { AgentIcon, DeviceIcon, Icon } from '@/ui/Icon';
import { Button, IconButton, NeedsYou, Screen, useBottomGap, Working } from '@/ui/parts';
import { fonts, type Palette, typeFor, useColors, useStyles } from '@/ui/theme';

function summary(snapshot: Snapshot): string {
  const agents = snapshot.chats.length;
  const terminals = snapshot.sessions.filter((session) => session.running).length;
  const parts = [];
  if (agents) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`);
  if (terminals) parts.push(`${terminals} terminal${terminals === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'Nothing running';
}

function DeviceCard({ device }: { device: PairedDevice }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const live = useLive(device.core);
  const away = live.status === 'closed';
  const snapshot = live.snapshot;
  const asking = !away && snapshot ? snapshot.attentions[0] : undefined;
  const askingChat = asking ? snapshot?.chats.find((chat) => chat.agentId === asking.agentId) : undefined;
  const working = !away && snapshot ? snapshot.chats.filter((chat) => chat.running) : [];
  const channel = channelLabel(device.channel);
  const behind = live.status === 'closed' ? live.outdated : undefined;
  const meta = behind
    ? behind === 'mac'
      ? 'Needs a newer Sikemux'
      : 'Update this app to connect'
    : away
      ? `Asleep or offline${device.lastSeen ? ` · seen ${ago(device.lastSeen)}` : ''}`
      : snapshot
        ? summary(snapshot)
        : 'Connecting…';

  return (
    <Pressable
      onPress={() => router.push(`/device/${device.core}`)}
      accessibilityRole="button"
      style={({ pressed }) => [styles.card, away && styles.away, pressed && { opacity: 0.85 }]}>
      <View style={styles.head}>
        <View style={styles.glyph}>
          <DeviceIcon kind={deviceKind(device.model)} color={away ? colors.tertiary : colors.ink} />
          <View style={[styles.presence, away ? styles.presenceOff : styles.presenceOn]} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, away && { color: colors.tertiary }]} numberOfLines={1}>
            {deviceName(device)}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {channel ? `${channel} · ${meta}` : meta}
          </Text>
        </View>
        <Icon name="IconChevron" size={14} color={colors.rest} />
      </View>
      {asking ? (
        <View style={styles.ask}>
          <AgentIcon provider={asking.provider} size={16} />
          <View style={{ flex: 1 }}>
            <Text style={styles.askTitle} numberOfLines={1}>
              {askingChat ? chatTitle(askingChat) : asking.provider}
            </Text>
            <Text style={styles.askDetail}>Needs input</Text>
          </View>
          <NeedsYou />
        </View>
      ) : null}
      {working.length ? (
        <View style={styles.work}>
          <View style={styles.faces}>
            {working.slice(0, 4).map((chat) => (
              <View key={chat.agentId} style={styles.face}>
                <AgentIcon provider={chat.provider} size={15} />
              </View>
            ))}
          </View>
          <Text style={styles.workText}>{working.length} working</Text>
          <Working />
        </View>
      ) : null}
    </Pressable>
  );
}

/** A Mac signed in to the same account that this phone has not paired with: it pairs with that Mac's code. */
function AccountMacCard({ mac }: { mac: Device }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const channel = channelLabel(mac.channel);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/pair-code', params: { core: mac.key, name: mac.name } })}
      accessibilityRole="button"
      accessibilityHint="Pairs with this Mac's code"
      style={({ pressed }) => [styles.card, styles.away, pressed && { opacity: 0.85 }]}>
      <View style={styles.head}>
        <View style={styles.glyph}>
          <DeviceIcon kind="laptop" color={colors.tertiary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, { color: colors.tertiary }]} numberOfLines={1}>
            {mac.name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {channel ? `${channel} · ` : ''}On your account · not paired yet
          </Text>
        </View>
        <Icon name="IconChevron" size={14} color={colors.rest} />
      </View>
    </Pressable>
  );
}

function Empty() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>No Macs yet</Text>
      <Text style={styles.emptyBody}>
        In Sikemux on your Mac, open Settings → Devices and sign in to this account, or pair with the code it shows.
      </Text>
      <Button kind="primary" title="Scan the code on your Mac" onPress={() => router.push('/scan')} style={styles.emptyButton} />
      <Pressable onPress={() => pasteFoundLink()} style={styles.paste} accessibilityRole="button">
        <Text style={styles.pasteText}>Paste a pairing link</Text>
      </Pressable>
    </View>
  );
}

export function DevicesList({ devices }: { devices: PairedDevice[] }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const bottom = useBottomGap();
  const { user } = useUser();
  const [account, setAccount] = useState(false);
  const macs = useAccountMacs();
  const unpaired = macs.filter((mac) => !devices.some((device) => device.core === mac.key));
  return (
    <Screen>
      <View style={styles.nav}>
        <IconButton name="IconPlus" label="Pair another device" onPress={() => router.push('/scan')} />
      </View>
      <Text style={styles.title}>Devices</Text>
      {devices.length || unpaired.length ? (
        <ScrollView contentContainerStyle={styles.list}>
          {devices.map((device) => (
            <DeviceCard key={device.core} device={device} />
          ))}
          {unpaired.map((mac) => (
            <AccountMacCard key={mac.key} mac={mac} />
          ))}
        </ScrollView>
      ) : (
        <Empty />
      )}
      <Pressable
        onPress={() => setAccount(true)}
        accessibilityRole="button"
        accessibilityLabel="Account"
        style={[styles.phone, { paddingBottom: bottom }]}>
        <Icon name="IconUser" size={15} color={colors.tertiary} />
        <Text style={styles.phoneText} numberOfLines={1}>
          {user?.primaryEmailAddress?.emailAddress ?? 'Account'}
        </Text>
        <Icon name="IconChevron" size={13} color={colors.rest} />
      </Pressable>
      <AccountSheet visible={account} onClose={() => setAccount(false)} />
    </Screen>
  );
}

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    nav: { height: 46, flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 8 },
    title: { ...type.title, fontSize: 26, paddingHorizontal: 16, paddingBottom: 14 },
    list: { paddingHorizontal: 16, gap: 10, paddingBottom: 24 },
    card: { borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, overflow: 'hidden' },
    away: { backgroundColor: 'transparent' },
    head: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingLeft: 16, paddingRight: 14 },
    glyph: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
    presence: { position: 'absolute', right: -1, bottom: 3, width: 10, height: 10, borderRadius: 5, borderWidth: 2.5 },
    presenceOn: { backgroundColor: colors.live, borderColor: colors.raised },
    presenceOff: { backgroundColor: colors.ground, borderColor: colors.rest },
    name: { ...type.heading },
    meta: { ...type.meta, marginTop: 2 },
    ask: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginHorizontal: 8,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.overlay,
    },
    askTitle: { fontFamily: fonts.uiMedium, fontSize: 13.5, color: colors.ink },
    askDetail: { ...type.meta, fontSize: 12.5, marginTop: 1 },
    work: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14 },
    faces: { flexDirection: 'row' },
    face: {
      width: 26,
      height: 26,
      borderRadius: 13,
      marginRight: -6,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.overlay,
      borderWidth: 2,
      borderColor: colors.raised,
    },
    workText: { flex: 1, marginLeft: 6, fontFamily: fonts.ui, fontSize: 13, color: colors.secondary },
    phone: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 16,
      paddingTop: 14,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    phoneText: { ...type.meta },
    empty: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 60 },
    emptyTitle: { ...type.title, fontSize: 20, textAlign: 'center' },
    emptyBody: { ...type.body, textAlign: 'center', marginTop: 8 },
    emptyButton: { marginTop: 24 },
    paste: { height: 44, alignItems: 'center', justifyContent: 'center' },
    pasteText: { fontFamily: fonts.uiMedium, fontSize: 15, color: colors.secondary },
  });
};
