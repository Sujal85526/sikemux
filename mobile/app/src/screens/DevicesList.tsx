import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useUser } from '@clerk/expo';
import * as Clipboard from 'expo-clipboard';
import type { Device } from '@protocol';

import { AccountSheet } from '@/account/AccountSheet';
import { Avatar } from '@/account/Avatar';
import { providerName } from '@/account/providers';
import { useAccountHosts } from '@/account/session';
import type { Snapshot } from '@/core/protocol';
import { useLive } from '@/devices/hub';
import { channelLabel, deviceKind, deviceName, type PairedDevice } from '@/devices/paired';
import { chatTitle, ago } from '@/devices/words';
import { AgentIcon, DeviceIcon, Icon } from '@/ui/Icon';
import { IconButton, NeedsYou, Screen, useBottomGap, Working } from '@/ui/parts';
import { fonts, type Palette, radius, typeFor, useColors, useStyles } from '@/ui/theme';

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
    ? behind === 'host'
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

/** A host signed in to the same account that this phone has not paired with: it asks that host to let this phone in. */
function AccountHostCard({ host }: { host: Device }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const channel = channelLabel(host.channel);
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/join', params: { core: host.key, name: host.name } })}
      accessibilityRole="button"
      accessibilityLabel={`Connect to ${host.name}`}
      style={({ pressed }) => [styles.card, styles.away, pressed && { opacity: 0.85 }]}>
      <View style={styles.head}>
        <View style={styles.glyph}>
          <DeviceIcon kind="laptop" color={colors.tertiary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, { color: colors.tertiary }]} numberOfLines={1}>
            {host.name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {channel ? `${channel} · ` : ''}On your account
          </Text>
        </View>
        <View style={styles.connect}>
          <Text style={styles.connectText}>Connect</Text>
        </View>
      </View>
    </Pressable>
  );
}

const DOWNLOAD = 'https://sikemux.com/phone';

/** Where the next host lands: it turns into that host's row once it signs in to the account. */
function HostSlot() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.slot}>
      <View style={styles.slotTile}>
        <DeviceIcon kind="laptop" size={22} color={colors.tertiary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.slotTitle}>Your computer goes here</Text>
        <View style={styles.watching}>
          <Working />
          <Text style={styles.watchingText}>Watching the account</Text>
        </View>
      </View>
    </View>
  );
}

function Step({ number, children }: { number: number; children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.step}>
      <View style={styles.stepNumber}>
        <Text style={styles.stepNumberText}>{number}</Text>
      </View>
      <Text style={styles.stepText}>{children}</Text>
    </View>
  );
}

function Chip({ title, primary, onPress }: { title: string; primary?: boolean; onPress: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.chip, primary && styles.chipPrimary, pressed && { opacity: 0.85 }]}>
      <Text style={[styles.chipText, primary && styles.chipTextPrimary]}>{title}</Text>
    </Pressable>
  );
}

/** How to bring a host in: install Sikemux there and sign in to this account; it then asks to let this phone in. */
function BringItIn() {
  const styles = useStyles(makeStyles);
  const { user } = useUser();
  const [copied, setCopied] = useState(false);
  const account = [providerName(user?.externalAccounts[0]?.provider), user?.primaryEmailAddress?.emailAddress].filter(Boolean).join(' · ');

  useEffect(() => {
    if (!copied) return;
    const reset = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(reset);
  }, [copied]);

  const send = () => {
    Share.share(Platform.OS === 'ios' ? { url: DOWNLOAD } : { message: DOWNLOAD }).catch(() => {});
  };
  const copy = () => {
    Clipboard.setStringAsync(DOWNLOAD)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <View style={styles.how}>
      <Text style={styles.howTitle}>Bring it in</Text>
      <View style={styles.steps}>
        <Step number={1}>
          Get Sikemux from <Text style={styles.strong}>sikemux.com</Text>
        </Step>
        <Step number={2}>
          Sign in with <Text style={styles.strong}>{account || 'this account'}</Text>
        </Step>
        <Step number={3}>
          Click <Text style={styles.strong}>Allow</Text> when it asks
        </Step>
      </View>
      <View style={styles.chips}>
        <Chip primary title="Send me the link" onPress={send} />
        <Chip title={copied ? 'Copied' : 'Copy link'} onPress={copy} />
      </View>
    </View>
  );
}

export function DevicesList({ devices }: { devices: PairedDevice[] }) {
  const styles = useStyles(makeStyles);
  const bottom = useBottomGap();
  const [account, setAccount] = useState(false);
  const { hosts } = useAccountHosts();
  const unpaired = hosts.filter((host) => !devices.some((device) => device.core === host.key));
  const count = devices.length + unpaired.length;
  // The slot stays while the list is as long as when + was pressed, so the host that fills it takes its place.
  const [addingAt, setAddingAt] = useState<number>();
  const waiting = count === 0 || addingAt === count;
  const list = useRef<ScrollView>(null);
  const reveal = useRef(false);

  const add = () => {
    reveal.current = true;
    setAddingAt(count);
  };

  return (
    <Screen>
      <View style={styles.nav}>
        <IconButton name="IconPlus" label="Add a host" onPress={add} />
        <Pressable onPress={() => setAccount(true)} accessibilityRole="button" accessibilityLabel="Account" style={styles.account}>
          <Avatar size={28} />
        </Pressable>
      </View>
      <Text style={styles.title}>Devices</Text>
      <ScrollView
        ref={list}
        contentContainerStyle={[styles.list, { paddingBottom: bottom + 12 }]}
        onContentSizeChange={() => {
          if (!reveal.current) return;
          reveal.current = false;
          list.current?.scrollToEnd({ animated: true });
        }}>
        {devices.map((device) => (
          <DeviceCard key={device.core} device={device} />
        ))}
        {unpaired.map((host) => (
          <AccountHostCard key={host.key} host={host} />
        ))}
        {waiting ? (
          <>
            <HostSlot />
            <BringItIn />
          </>
        ) : null}
      </ScrollView>
      <AccountSheet visible={account} onClose={() => setAccount(false)} />
    </Screen>
  );
}

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    nav: { height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 8 },
    account: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    title: { ...type.title, fontSize: 26, paddingHorizontal: 16, paddingBottom: 14 },
    list: { paddingHorizontal: 16, gap: 10 },
    card: { borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, overflow: 'hidden' },
    away: { backgroundColor: 'transparent' },
    head: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingLeft: 16, paddingRight: 14 },
    glyph: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
    presence: { position: 'absolute', right: -1, bottom: 3, width: 10, height: 10, borderRadius: 5, borderWidth: 2.5 },
    presenceOn: { backgroundColor: colors.live, borderColor: colors.raised },
    presenceOff: { backgroundColor: colors.ground, borderColor: colors.rest },
    name: { ...type.heading },
    meta: { ...type.meta, marginTop: 2 },
    connect: {
      height: 32,
      paddingHorizontal: 13,
      justifyContent: 'center',
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.raised,
    },
    connectText: { fontFamily: fonts.uiSemibold, fontSize: 14, color: colors.ink },
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
    slot: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 14,
      borderRadius: radius.row,
      borderWidth: 1.5,
      borderStyle: 'dashed',
      borderColor: colors.borderStrong,
    },
    slotTile: {
      width: 40,
      height: 40,
      borderRadius: radius.control,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.active,
    },
    slotTitle: { ...type.row, color: colors.secondary },
    watching: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 3 },
    watchingText: { ...type.meta, fontSize: 12.5 },
    how: {
      marginTop: 8,
      padding: 16,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.raised,
    },
    howTitle: { fontFamily: fonts.uiSemibold, fontSize: 15, color: colors.ink },
    steps: { marginTop: 10, gap: 9 },
    step: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    stepNumber: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.active },
    stepNumberText: { fontFamily: fonts.uiSemibold, fontSize: 11.5, color: colors.ink },
    stepText: { flex: 1, fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: colors.secondary },
    strong: { fontFamily: fonts.uiSemibold, color: colors.ink },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
    chip: {
      height: 36,
      paddingHorizontal: 14,
      justifyContent: 'center',
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.borderStrong,
    },
    chipPrimary: { backgroundColor: colors.ink, borderColor: colors.ink },
    chipText: { fontFamily: fonts.uiSemibold, fontSize: 14, color: colors.ink },
    chipTextPrimary: { color: colors.ground },
  });
};
