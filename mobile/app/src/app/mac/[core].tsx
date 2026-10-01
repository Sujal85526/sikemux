import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';

import type { ChatInfo, SessionInfo, Snapshot } from '@/core/protocol';
import { useMac } from '@/macs/connection';
import { shortKey } from '@/macs/paired';
import { colors, common } from '@/theme';

function folder(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function Row({ title, detail, flagged }: { title: string; detail: string; flagged?: boolean }) {
  return (
    <View style={[styles.row, flagged && styles.flagged]}>
      <Text style={common.text}>{title}</Text>
      <Text style={styles.detail}>{detail}</Text>
    </View>
  );
}

function chatDetail(chat: ChatInfo): string {
  if (chat.pendingPermissions.length > 0) return 'Waiting for your permission';
  if (chat.state === 'starting') return 'Starting';
  return chat.running ? 'Working' : 'Idle';
}

function sessionTitle(session: SessionInfo, snapshot: Snapshot): string {
  const project = snapshot.workspace.projects.find((known) => known.id === session.project);
  const name = session.agentType ?? (session.kind === 'task' ? 'Task' : 'Terminal');
  return project ? `${name} · ${project.name}` : name;
}

function Contents({ snapshot }: { snapshot: Snapshot }) {
  const terminals = snapshot.sessions.filter((session) => session.running);
  return (
    <>
      {snapshot.attentions.length > 0 && (
        <>
          <Text style={common.label}>Needs you</Text>
          {snapshot.attentions.map((attention) => (
            <Row
              key={attention.id}
              title={`${attention.provider} asks for permission`}
              detail={folder(attention.cwd)}
              flagged
            />
          ))}
        </>
      )}
      <Text style={common.label}>Agents</Text>
      {snapshot.chats.length === 0 && <Text style={styles.detail}>No agents running.</Text>}
      {snapshot.chats.map((chat) => (
        <Row key={chat.agentId} title={`${chat.provider} · ${folder(chat.cwd)}`} detail={chatDetail(chat)} />
      ))}
      <Text style={common.label}>Terminals</Text>
      {terminals.length === 0 && <Text style={styles.detail}>No terminals open.</Text>}
      {terminals.map((session) => (
        <Row
          key={session.id}
          title={sessionTitle(session, snapshot)}
          detail={session.agentState ?? 'Running'}
        />
      ))}
    </>
  );
}

export default function Mac() {
  const { core } = useLocalSearchParams<{ core: string }>();
  const { mac, reconnect } = useMac(core);

  return (
    <SafeAreaView style={common.screen}>
      <ScrollView
        contentContainerStyle={common.body}
        refreshControl={<RefreshControl refreshing={false} onRefresh={reconnect} tintColor={colors.muted} />}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>Macs</Text>
        </Pressable>
        <Text style={common.title}>Mac {shortKey(core)}</Text>
        {mac.state === 'connecting' && <Text style={styles.detail}>Connecting…</Text>}
        {mac.state === 'open' && !mac.snapshot && <Text style={styles.detail}>Connected</Text>}
        {mac.state === 'open' && mac.snapshot && <Contents snapshot={mac.snapshot} />}
        {mac.state === 'closed' && (
          <>
            <Text style={styles.problem}>{mac.problem}</Text>
            <Pressable style={common.button} onPress={reconnect}>
              <Text style={common.buttonText}>Connect again</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = {
  back: { color: colors.accent, fontSize: 16, marginBottom: 8 },
  row: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
    gap: 4,
  },
  flagged: { borderColor: colors.accent, backgroundColor: '#1C1E33' },
  detail: { color: colors.muted, fontSize: 13 },
  problem: { color: colors.danger, fontSize: 15, lineHeight: 21, marginTop: 12 },
} as const;
