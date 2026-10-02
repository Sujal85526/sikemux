import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import type { ChatInfo, SessionInfo, Snapshot } from '@/core/protocol';
import { useDevices, useLive } from '@/devices/hub';
import { deviceKind, deviceName } from '@/devices/paired';
import { chatState, chatTitle, folder } from '@/devices/words';
import { AgentIcon, DeviceIcon, Icon } from '@/ui/Icon';
import { Group, Nav, NeedsYou, Row, Screen, SectionLabel, Track, Working } from '@/ui/parts';
import { colors, fonts, radius, type } from '@/ui/theme';

type Tab = 'agents' | 'terminals';

function projectName(snapshot: Snapshot, cwd: string): string {
  return snapshot.workspace.projects.find((project) => project.path === cwd)?.name ?? folder(cwd);
}

function ChatEnd({ chat }: { chat: ChatInfo }) {
  if (chat.pendingPermissions.length) return <NeedsYou />;
  if (chat.running) return <Working />;
  return null;
}

function Agents({ snapshot }: { snapshot: Snapshot }) {
  const [filter, setFilter] = useState<string>('all');
  const providers = useMemo(() => [...new Set(snapshot.chats.map((chat) => chat.provider))], [snapshot.chats]);
  const chats = snapshot.chats.filter((chat) => filter === 'all' || chat.provider === filter);
  const asking = chats.filter((chat) => chat.pendingPermissions.length);
  const open = chats.filter((chat) => !chat.pendingPermissions.length);

  return (
    <>
      {providers.length > 1 ? (
        <View style={styles.filters}>
          <Pressable onPress={() => setFilter('all')} style={[styles.filter, filter === 'all' && styles.filterOn]}>
            <Text style={[styles.filterText, filter === 'all' && { color: colors.ink }]}>All</Text>
          </Pressable>
          {providers.map((provider) => (
            <Pressable
              key={provider}
              onPress={() => setFilter(provider)}
              style={[styles.filter, filter === provider && styles.filterOn]}
              accessibilityLabel={provider}>
              <AgentIcon provider={provider} size={17} />
            </Pressable>
          ))}
        </View>
      ) : null}
      {asking.map((chat) => (
        <View key={chat.agentId} style={styles.ask}>
          <AgentIcon provider={chat.provider} size={22} />
          <View style={{ flex: 1 }}>
            <Text style={styles.askTitle} numberOfLines={1}>
              {chatTitle(chat)}
            </Text>
            <Text style={styles.askDetail} numberOfLines={1}>
              Needs input · {projectName(snapshot, chat.cwd)}
            </Text>
          </View>
          <NeedsYou />
        </View>
      ))}
      {open.length ? (
        <>
          <SectionLabel>Open</SectionLabel>
          <Group>
            {open.map((chat) => (
              <Row
                key={chat.agentId}
                mark={<AgentIcon provider={chat.provider} size={22} />}
                title={chatTitle(chat)}
                detail={`${projectName(snapshot, chat.cwd)} · ${chatState(chat)}`}
                end={<ChatEnd chat={chat} />}
              />
            ))}
          </Group>
        </>
      ) : null}
      {!snapshot.chats.length ? <Text style={styles.empty}>No agents running.</Text> : null}
    </>
  );
}

function terminalTitle(session: SessionInfo): string {
  if (session.task) return session.task.label;
  return session.agentType ?? 'Terminal';
}

function terminalDetail(session: SessionInfo): string {
  if (session.task) return session.task.command;
  if (session.running) return 'Running';
  if (session.exit?.signal) return `stopped by ${session.exit.signal}`;
  return session.exit?.code != null ? `exited ${session.exit.code}` : 'exited';
}

function Terminals({ snapshot }: { snapshot: Snapshot }) {
  const groups = new Map<string, SessionInfo[]>();
  for (const session of snapshot.sessions) {
    const project = snapshot.workspace.projects.find((known) => known.id === session.project)?.name ?? 'Other';
    groups.set(project, [...(groups.get(project) ?? []), session]);
  }
  if (!snapshot.sessions.length) return <Text style={styles.empty}>No terminals open.</Text>;
  return (
    <>
      {[...groups].map(([project, sessions]) => (
        <View key={project}>
          <SectionLabel>{project}</SectionLabel>
          <Group>
            {sessions.map((session) => (
              <Row
                key={session.id}
                dim={!session.running}
                mark={<Icon name={session.task ? 'IconRun' : 'IconCommand'} size={session.task ? 15 : 18} color={session.running ? colors.secondary : colors.tertiary} />}
                title={terminalTitle(session)}
                detail={<Text style={type.mono}>{terminalDetail(session)}</Text>}
                end={session.running ? session.task ? <Working /> : <View style={styles.liveDot} /> : null}
              />
            ))}
          </Group>
        </View>
      ))}
    </>
  );
}

function summary(snapshot?: Snapshot): string {
  if (!snapshot) return 'Connecting…';
  const terminals = snapshot.sessions.filter((session) => session.running).length;
  return `${snapshot.chats.length} agent${snapshot.chats.length === 1 ? '' : 's'} · ${terminals} terminal${terminals === 1 ? '' : 's'}`;
}

export default function Device() {
  const { core, tab: linkedTab } = useLocalSearchParams<{ core: string; tab?: Tab }>();
  const { devices } = useDevices();
  const device = devices.find((known) => known.core === core);
  const live = useLive(core);
  const [tab, setTab] = useState<Tab>(linkedTab === 'terminals' ? 'terminals' : 'agents');
  useEffect(() => {
    if (linkedTab === 'agents' || linkedTab === 'terminals') setTab(linkedTab);
  }, [linkedTab]);
  const away = live.status === 'closed';
  const snapshot = live.snapshot;
  const asking = snapshot?.chats.filter((chat) => chat.pendingPermissions.length).length ?? 0;

  return (
    <Screen>
      <Nav back="Devices" />
      <View style={styles.header}>
        <View style={styles.glyph}>
          <DeviceIcon kind={deviceKind(device?.model)} color={away ? colors.tertiary : colors.ink} />
          <View style={[styles.presence, away ? styles.presenceOff : styles.presenceOn]} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {device ? deviceName(device) : 'Mac'}
          </Text>
          <Text style={type.meta}>{away ? 'Asleep or offline' : summary(snapshot)}</Text>
        </View>
      </View>
      {away && !snapshot ? (
        <View style={styles.away}>
          <Text style={[type.title, { fontSize: 20, textAlign: 'center' }]}>Can't reach this Mac</Text>
          <Text style={[type.body, { textAlign: 'center', marginTop: 8 }]}>
            It may be asleep, offline, or have remote access turned off.
          </Text>
          <View style={styles.trying}>
            <Working />
            <Text style={type.meta}>Trying again</Text>
          </View>
        </View>
      ) : (
        <>
          <View style={{ paddingHorizontal: 16 }}>
            <Track<Tab>
              value={tab}
              onChange={setTab}
              options={[
                { value: 'agents', label: 'Agents', count: asking },
                { value: 'terminals', label: 'Terminals' },
              ]}
            />
          </View>
          <ScrollView contentContainerStyle={styles.body}>
            {snapshot ? tab === 'agents' ? <Agents snapshot={snapshot} /> : <Terminals snapshot={snapshot} /> : null}
          </ScrollView>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingTop: 4, paddingBottom: 16 },
  glyph: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  presence: { position: 'absolute', right: -1, bottom: 3, width: 10, height: 10, borderRadius: 5, borderWidth: 2.5 },
  presenceOn: { backgroundColor: colors.live, borderColor: colors.ground },
  presenceOff: { backgroundColor: colors.ground, borderColor: colors.rest },
  name: { ...type.title },
  body: { paddingHorizontal: 16, paddingBottom: 40 },
  filters: { flexDirection: 'row', gap: 6, paddingTop: 12 },
  filter: { height: 32, minWidth: 40, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  filterOn: { backgroundColor: colors.active, borderColor: colors.borderStrong },
  filterText: { fontFamily: fonts.ui, fontSize: 13, color: colors.secondary },
  ask: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.overlay,
  },
  askTitle: { fontFamily: fonts.uiMedium, fontSize: 15.5, color: colors.ink },
  askDetail: { ...type.meta, marginTop: 2 },
  empty: { ...type.meta, textAlign: 'center', paddingTop: 40 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.live },
  away: { flex: 1, justifyContent: 'center', paddingHorizontal: 32, paddingBottom: 120 },
  trying: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 16 },
});
