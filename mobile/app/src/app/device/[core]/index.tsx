import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import type { ChatInfo, ProjectInfo, SessionInfo, Snapshot } from '@/core/protocol';
import { reloadDevices, retry, useDevices, useHostStatus, useLive } from '@/devices/hub';
import { deviceName, type PairedDevice, updateDevice } from '@/devices/paired';
import { ForgetSheet, useForget } from '@/devices/ForgetSheet';
import { ProjectSheet } from '@/devices/ProjectSheet';
import { asking as askingOf } from '@/devices/asking';
import { summary } from '@/devices/status';
import { chatState, chatTitle, folder } from '@/devices/words';
import { Wants } from '@/screens/Wants';
import { haptics } from '@/ui/haptics';
import { AgentIcon, Icon } from '@/ui/Icon';
import { Button, IconButton, Nav, NeedsYou, Row, Rows, Screen, SectionLabel, useBottomGap, Working } from '@/ui/parts';
import { fonts, type Palette, typeFor, useColors, useStyles, useType, translucent } from '@/ui/theme';

type Tab = 'agents' | 'terminals';

/** The New chat pill's height, which the list leaves room for below its last row. */
const NEW_CHAT_HEIGHT = 52;

function projectName(snapshot: Snapshot, cwd: string): string {
  return snapshot.workspace.projects.find((project) => project.path === cwd)?.name ?? folder(cwd);
}

function inProject(project: ProjectInfo, cwd: string): boolean {
  return cwd === project.path || cwd.startsWith(`${project.path}/`);
}

/** What runs in a project, as its row in the project sheet shows it. */
function ProjectTail({ snapshot, project }: { snapshot: Snapshot; project: ProjectInfo }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const type = useType();
  const chats = snapshot.chats.filter((chat) => inProject(project, chat.cwd));
  const terminals = snapshot.sessions.filter((session) => session.project === project.id && session.running).length;
  const waiting = chats.some((chat) => chat.pendingPermissions.length);
  if (!chats.length && !terminals) return null;
  return (
    <View style={styles.tail}>
      {waiting ? <NeedsYou /> : null}
      {chats.length ? (
        <View style={styles.faces}>
          {chats.slice(0, 3).map((chat, index) => (
            <View key={chat.agentId} style={[styles.face, index > 0 && { marginLeft: -7 }]}>
              <AgentIcon provider={chat.provider} size={14} />
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.termCount}>
          <Icon name="IconCommand" size={13} color={colors.tertiary} />
          <Text style={type.meta}>{terminals}</Text>
        </View>
      )}
    </View>
  );
}

function ChatEnd({ chat }: { chat: ChatInfo }) {
  if (chat.pendingPermissions.length) return <NeedsYou />;
  if (chat.running) return <Working />;
  return null;
}

function Agents({ core, snapshot, scope, provider }: { core: string; snapshot: Snapshot; scope?: ProjectInfo; provider: string }) {
  const styles = useStyles(makeStyles);
  const open = (agentId: string) => router.push(`/device/${core}/chat/${agentId}`);
  const scoped = snapshot.chats.filter((chat) => !scope || inProject(scope, chat.cwd));
  const chats = scoped.filter((chat) => provider === 'all' || chat.provider === provider);
  const where = (chat: ChatInfo, state: string) => (scope ? state : `${projectName(snapshot, chat.cwd)} · ${state}`);
  const asking = chats.filter((chat) => chat.pendingPermissions.length);
  const attentionOf = (chat: ChatInfo) => snapshot.attentions.find((known) => known.agentId === chat.agentId && askingOf(known));
  const idle = chats.filter((chat) => !chat.pendingPermissions.length);

  return (
    <>
      {asking.length ? (
        <Rows style={styles.asking}>
          {asking.map((chat) => (
            <Row
              key={chat.agentId}
              bright
              mark={<AgentIcon provider={chat.provider} size={20} />}
              title={chatTitle(chat)}
              detail={
                attentionOf(chat) ? (
                  <>
                    Needs input · <Wants attention={attentionOf(chat)} />
                  </>
                ) : (
                  where(chat, 'Needs input')
                )
              }
              end={<NeedsYou />}
              onPress={() => open(chat.agentId)}
            />
          ))}
        </Rows>
      ) : null}
      {idle.length ? (
        <>
          <SectionLabel>Open</SectionLabel>
          <Rows>
            {idle.map((chat) => (
              <Row
                key={chat.agentId}
                mark={<AgentIcon provider={chat.provider} size={20} />}
                title={chatTitle(chat)}
                detail={where(chat, chatState(chat))}
                end={<ChatEnd chat={chat} />}
                onPress={() => open(chat.agentId)}
              />
            ))}
          </Rows>
        </>
      ) : null}
      {!scoped.length ? <Text style={styles.empty}>{scope ? `No agents in ${scope.name}.` : 'No agents running.'}</Text> : null}
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

function Terminals({ snapshot, scope }: { snapshot: Snapshot; scope?: ProjectInfo }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const type = useType();
  const groups = new Map<string, SessionInfo[]>();
  for (const session of snapshot.sessions) {
    if (scope && session.project !== scope.id) continue;
    const project = snapshot.workspace.projects.find((known) => known.id === session.project)?.name ?? 'Other';
    groups.set(project, [...(groups.get(project) ?? []), session]);
  }
  if (!groups.size) return <Text style={styles.empty}>{scope ? `No terminals in ${scope.name}.` : 'No terminals open.'}</Text>;
  return (
    <>
      {[...groups].map(([project, sessions]) => (
        <View key={project}>
          {scope ? <View style={{ height: 8 }} /> : <SectionLabel>{project}</SectionLabel>}
          <Rows>
            {sessions.map((session) => (
              <Row
                key={session.id}
                dim={!session.running}
                mark={
                  <Icon
                    name={session.task ? 'IconRun' : 'IconCommand'}
                    size={session.task ? 15 : 18}
                    color={session.running ? colors.secondary : colors.tertiary}
                  />
                }
                title={terminalTitle(session)}
                detail={<Text style={type.mono}>{terminalDetail(session)}</Text>}
                end={session.running ? session.task ? <Working /> : <View style={styles.liveDot} /> : null}
              />
            ))}
          </Rows>
        </View>
      ))}
    </>
  );
}

/** The host's name set large over its backdrop, under a line saying whether it is online and what runs on it. */
function HostHead({ name, line, online }: { name: string; line: string; online: boolean }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.head}>
      <View style={styles.where}>
        <View style={online ? styles.online : styles.offline} />
        <Text style={styles.whereText} numberOfLines={1}>
          {line}
        </Text>
      </View>
      <Text style={styles.name} numberOfLines={1} maxFontSizeMultiplier={1.4} accessibilityRole="header">
        {name}
      </Text>
    </View>
  );
}

function HostTab({ label, count, on, onPress }: { label: string; count?: number; on: boolean; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable onPress={onPress} hitSlop={12} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected: on }}>
      <Text style={[styles.tabText, on && { color: colors.ink }]}>{label}</Text>
      {count ? (
        <View style={styles.count}>
          <Text style={styles.countText} maxFontSizeMultiplier={1.3}>
            {count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** The host turned this phone away: only forgetting it here and connecting again helps. */
function Unpaired({ device }: { device?: PairedDevice }) {
  const styles = useStyles(makeStyles);
  const type = useType();
  const { forgetting, problem, leave } = useForget(device);
  return (
    <View style={styles.away}>
      <Text style={[type.title, { fontSize: 20, textAlign: 'center' }]} accessibilityRole="header">
        This host no longer knows this phone
      </Text>
      <Text style={[type.body, { textAlign: 'center', marginTop: 8 }]}>
        It was removed on the host. Forget it here, then connect to it again from Devices.
      </Text>
      {problem ? <Text style={styles.problem}>{problem}</Text> : null}
      <Button
        kind="danger"
        title={forgetting ? 'Forgetting…' : 'Forget this host'}
        onPress={() => void leave()}
        disabled={forgetting || !device}
        style={styles.retry}
      />
    </View>
  );
}

export { Crashed as ErrorBoundary } from '@/screens/Crashed';

export default function Device() {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const type = useType();
  const { core, tab: linkedTab } = useLocalSearchParams<{ core: string; tab?: Tab }>();
  const { devices } = useDevices();
  const device = devices.find((known) => known.core === core);
  const live = useLive(core);
  const status = useHostStatus(core);
  const [tab, setTab] = useState<Tab>(linkedTab === 'terminals' ? 'terminals' : 'agents');
  const [followedLink, setFollowedLink] = useState(linkedTab);
  if (linkedTab !== followedLink) {
    setFollowedLink(linkedTab);
    if (linkedTab === 'agents' || linkedTab === 'terminals') setTab(linkedTab);
  }
  const behind = status.outdated;
  const away = live.status === 'closed' || !!status.problem;
  const unreachable =
    behind === 'host'
      ? { title: 'This host needs a newer Sikemux', body: 'Update Sikemux on the host, then come back here.' }
      : behind === 'phone'
        ? { title: 'Update this app', body: 'This host runs a newer Sikemux than this app understands.' }
        : { title: "Can't reach this host", body: 'It may be asleep, offline, or have remote access turned off.' };
  const snapshot = live.snapshot;
  const [picking, setPicking] = useState(false);
  const [options, setOptions] = useState(false);
  const starts = device?.access === 'full' && status.online && tab === 'agents';
  const bottom = useBottomGap();
  const scope = snapshot?.workspace.projects.find((project) => project.id === device?.project);
  const asking = snapshot?.chats.filter((chat) => chat.pendingPermissions.length && (!scope || inProject(scope, chat.cwd))).length ?? 0;
  const [filter, setFilter] = useState('all');
  const providers = [...new Set(snapshot?.chats.filter((chat) => !scope || inProject(scope, chat.cwd)).map((chat) => chat.provider) ?? [])];
  const provider = providers.includes(filter) ? filter : 'all';
  const filtering = tab === 'agents' && providers.length > 1;
  const scopeTo = (project: string | null) => {
    setPicking(false);
    updateDevice(core, { project: project ?? undefined })
      .then(reloadDevices)
      .catch(() => {});
  };
  const switchTo = (next: Tab) => {
    if (next !== tab) haptics.select();
    setTab(next);
  };

  return (
    <Screen>
      <Nav back="Devices" end={device ? <IconButton name="IconMore" label="Options" onPress={() => setOptions(true)} /> : null} />
      {device ? <ForgetSheet device={device} visible={options} onClose={() => setOptions(false)} /> : null}
      <HostHead name={device ? deviceName(device) : 'Host'} line={status.line} online={status.online} />
      {status.unpaired ? (
        <Unpaired device={device} />
      ) : away && !snapshot ? (
        <View style={styles.away}>
          <Text style={[type.title, { fontSize: 20, textAlign: 'center' }]}>{unreachable.title}</Text>
          <Text style={[type.body, { textAlign: 'center', marginTop: 8 }]}>{unreachable.body}</Text>
          {behind ? null : (
            <>
              <View style={styles.trying}>
                <Working />
                <Text style={type.meta}>Trying again</Text>
              </View>
              <Button
                title="Try now"
                onPress={() => {
                  haptics.tap();
                  retry(core);
                }}
                style={styles.retry}
              />
            </>
          )}
        </View>
      ) : !snapshot ? (
        <View style={styles.away}>
          <View style={styles.trying}>
            <Working />
          </View>
        </View>
      ) : (
        <>
          <View style={styles.bar}>
            <View style={styles.tabs} accessibilityRole="tablist">
              <HostTab label="Agents" count={asking} on={tab === 'agents'} onPress={() => switchTo('agents')} />
              <HostTab label="Terminals" on={tab === 'terminals'} onPress={() => switchTo('terminals')} />
            </View>
            {snapshot.workspace.projects.length || filtering ? (
              <Pressable
                onPress={() => setPicking(true)}
                hitSlop={12}
                style={styles.picker}
                accessibilityRole="button"
                accessibilityLabel="Project">
                <Icon name="IconFolder" size={14} color={colors.live} />
                <Text style={styles.pickerText} numberOfLines={1}>
                  {scope?.name ?? 'All projects'}
                </Text>
                {filtering && provider !== 'all' ? <AgentIcon provider={provider} size={14} /> : null}
                <View style={{ transform: [{ rotate: '90deg' }] }}>
                  <Icon name="IconChevron" size={12} color={colors.inkFaint} />
                </View>
              </Pressable>
            ) : null}
          </View>
          <ScrollView
            style={status.online ? undefined : styles.stale}
            accessibilityHint={status.online ? undefined : 'Out of date until the host answers again'}
            contentContainerStyle={[styles.body, { paddingBottom: bottom + (starts ? NEW_CHAT_HEIGHT + 24 : 24) }]}>
            {snapshot ? (
              tab === 'agents' ? (
                <Agents core={core} snapshot={snapshot} scope={scope} provider={provider} />
              ) : (
                <Terminals snapshot={snapshot} scope={scope} />
              )
            ) : null}
          </ScrollView>
          {starts ? (
            <Pressable
              onPress={() => router.push(scope ? `/device/${core}/new?project=${encodeURIComponent(scope.id)}` : `/device/${core}/new`)}
              style={({ pressed }) => [styles.newChat, { bottom }, pressed && { opacity: 0.85 }]}
              accessibilityRole="button"
              accessibilityLabel="New chat">
              <Icon name="IconPlus" size={18} color={colors.ground} />
              <Text style={styles.newChatText}>New chat</Text>
            </Pressable>
          ) : null}
          {snapshot ? (
            <ProjectSheet
              visible={picking}
              onClose={() => setPicking(false)}
              device={device ? deviceName(device) : undefined}
              projects={snapshot.workspace.projects}
              chosen={scope?.id ?? null}
              onChoose={scopeTo}
              all={summary(snapshot)}
              tail={(project) => <ProjectTail snapshot={snapshot} project={project} />}
              providers={filtering ? { offered: providers, chosen: provider, onChoose: setFilter } : undefined}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    head: { minHeight: 168, justifyContent: 'flex-end', paddingHorizontal: 18, paddingBottom: 16 },
    where: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    whereText: { flexShrink: 1, fontFamily: fonts.ui, fontSize: 13, color: translucent(colors.ink, 0.72) },
    online: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.live,
      shadowColor: colors.live,
      shadowOpacity: 1,
      shadowRadius: 5,
      shadowOffset: { width: 0, height: 0 },
    },
    offline: { width: 7, height: 7, borderRadius: 4, borderWidth: 1.5, borderColor: colors.rest },
    name: {
      marginTop: 4,
      fontFamily: fonts.uiSemibold,
      fontSize: 32,
      letterSpacing: -1.12,
      color: colors.ink,
      textShadowColor: 'rgba(0, 0, 0, 0.65)',
      textShadowOffset: { width: 0, height: 2 },
      textShadowRadius: 18,
    },
    bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 18, paddingTop: 4 },
    tabs: { flexDirection: 'row', alignItems: 'center', gap: 20 },
    tab: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    tabText: { fontFamily: fonts.uiSemibold, fontSize: 15, letterSpacing: -0.15, color: colors.tertiary },
    count: {
      minWidth: 16,
      minHeight: 16,
      borderRadius: 8,
      paddingHorizontal: 6,
      backgroundColor: colors.ink,
      alignItems: 'center',
      justifyContent: 'center',
    },
    countText: { fontFamily: fonts.uiSemibold, fontSize: 11, color: colors.ground },
    picker: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
    pickerText: { flexShrink: 1, fontFamily: fonts.ui, fontSize: 13, color: colors.secondary },
    body: { paddingHorizontal: 16 },
    newChat: {
      position: 'absolute',
      right: 16,
      height: NEW_CHAT_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingLeft: 16,
      paddingRight: 20,
      borderRadius: NEW_CHAT_HEIGHT / 2,
      backgroundColor: colors.ink,
      shadowColor: '#000',
      shadowOpacity: 0.45,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
      elevation: 8,
    },
    newChatText: { fontFamily: fonts.uiSemibold, fontSize: 15, color: colors.ground },
    tail: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    faces: { flexDirection: 'row' },
    face: {
      width: 26,
      height: 26,
      borderRadius: 13,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.overlay,
      alignItems: 'center',
      justifyContent: 'center',
    },
    termCount: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    asking: { marginTop: 8 },
    empty: { ...type.meta, textAlign: 'center', paddingTop: 40 },
    liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.live },
    away: { flex: 1, justifyContent: 'center', paddingHorizontal: 32, paddingBottom: 120 },
    trying: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 16 },
    retry: { marginTop: 24 },
    stale: { opacity: 0.5 },
    problem: { ...type.meta, color: colors.danger, textAlign: 'center', marginTop: 12 },
  });
};
