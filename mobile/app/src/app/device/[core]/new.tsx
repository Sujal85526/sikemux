import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';

import { composerPlaceholder } from '@mac/chat/chatStatus';
import type { LauncherInfo, ProjectInfo } from '@/core/protocol';
import { useLive } from '@/devices/hub';
import { AgentIcon, Icon } from '@/ui/Icon';
import { Nav, Screen, Working } from '@/ui/parts';
import { colors, fonts, type } from '@/ui/theme';

const IDLE = composerPlaceholder({ connection: 'ready', running: false }, { resuming: false, disconnected: false });

function home(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

function Sheet({ visible, onClose, tall, children }: { visible: boolean; onClose: () => void; tall?: boolean; children: React.ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <SafeAreaView edges={['bottom']} style={[styles.sheet, tall && { height: '82%' }]}>
        <View style={styles.grabber} />
        {children}
      </SafeAreaView>
    </Modal>
  );
}

function AgentSheet({ visible, onClose, launchers, chosen, onChoose }: { visible: boolean; onClose: () => void; launchers: LauncherInfo[]; chosen?: LauncherInfo; onChoose: (launcher: LauncherInfo) => void }) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      <Text style={styles.sheetLabel}>Agent</Text>
      <View style={styles.agents}>
        {launchers.map((launcher) => {
          const on = launcher.id === chosen?.id;
          return (
            <Pressable key={launcher.id} onPress={() => onChoose(launcher)} style={[styles.agent, on && styles.agentOn]} accessibilityRole="button">
              <AgentIcon provider={launcher.provider} size={22} />
              <Text style={[styles.agentText, on && { color: colors.ink }]} numberOfLines={1}>
                {launcher.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

function ProjectSheet({ visible, onClose, projects, chosen, onChoose }: { visible: boolean; onClose: () => void; projects: ProjectInfo[]; chosen?: ProjectInfo; onChoose: (project: ProjectInfo) => void }) {
  const [query, setQuery] = useState('');
  const found = projects.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Sheet visible={visible} onClose={onClose} tall>
      <View style={[styles.search, query ? { borderColor: colors.borderSelected } : null]}>
        <Icon name="IconSearch" size={16} color={colors.tertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search projects…"
          placeholderTextColor={colors.tertiary}
          style={styles.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          keyboardAppearance="dark"
          returnKeyType="go"
          onSubmitEditing={() => found[0] && onChoose(found[0])}
        />
      </View>
      {!query ? <Text style={styles.sheetLabel}>Open</Text> : <View style={{ height: 12 }} />}
      <ScrollView keyboardShouldPersistTaps="handled">
        <View style={styles.group}>
          {found.map((project, index) => {
            const on = project.id === chosen?.id;
            return (
              <Pressable key={project.id} onPress={() => onChoose(project)} style={[styles.project, on && { backgroundColor: colors.active }, index > 0 && styles.divided]}>
                <Icon name="IconFolder" size={16} color={on ? colors.live : colors.tertiary} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.projectName, on && { color: colors.ink }]}>{project.name}</Text>
                  <Text style={styles.projectPath} numberOfLines={1} ellipsizeMode="head">
                    {home(project.path)}
                  </Text>
                </View>
                {on ? <Icon name="IconCheck" size={16} color={colors.ink} /> : null}
              </Pressable>
            );
          })}
        </View>
        {!found.length ? <Text style={[type.meta, { textAlign: 'center', paddingTop: 24 }]}>No open project matches.</Text> : null}
      </ScrollView>
    </Sheet>
  );
}

export default function NewChat() {
  const { core } = useLocalSearchParams<{ core: string }>();
  const live = useLive(core);
  const workspace = live.snapshot?.workspace;
  const [launcherId, setLauncherId] = useState<string>();
  const [projectId, setProjectId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [sheet, setSheet] = useState<'agent' | 'project'>();
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string>();
  const launcher = useMemo(() => workspace?.launchers.find((known) => known.id === launcherId) ?? workspace?.launchers[0], [workspace, launcherId]);
  const project = useMemo(() => workspace?.projects.find((known) => known.id === projectId) ?? workspace?.projects[0], [workspace, projectId]);
  const yolo = launcher?.permissionMode === 'bypass' || launcher?.permissionMode === 'bypassPermissions';

  const start = async () => {
    const text = draft.trim();
    if (!text || !launcher || !project || live.status !== 'open') return;
    setStarting(true);
    setProblem(undefined);
    try {
      const begun = JSON.parse(
        await live.connection.request(
          JSON.stringify({ op: 'startChat', launcher: launcher.id, project: project.id, permissionMode: null, model: null, effort: null }),
        ),
      ) as { kind: string; agentId?: string };
      if (!begun.agentId) throw new Error('The Mac did not start the agent.');
      await live.connection.request(JSON.stringify({ op: 'acpPrompt', agentId: begun.agentId, text, paths: [], context: [] }));
      router.replace(`/device/${core}/chat/${begun.agentId}`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setStarting(false);
    }
  };

  return (
    <Screen>
      <Nav back="Cancel" title="New chat" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.welcome}>
          {launcher ? <AgentIcon provider={launcher.provider} size={40} /> : null}
          <Text style={styles.welcomeTitle}>{project?.name ?? 'New chat'}</Text>
          {workspace && !workspace.launchers.length ? (
            <Text style={[type.meta, { textAlign: 'center' }]}>Open Sikemux on the Mac so it can offer its agents.</Text>
          ) : null}
          {problem ? <Text style={styles.problem}>{problem}</Text> : null}
        </View>
        <SafeAreaView edges={['bottom']} style={styles.wrap}>
          {project ? (
            <Pressable style={styles.strip} onPress={() => setSheet('project')} accessibilityRole="button" accessibilityLabel="Project">
              <Icon name="IconFolder" size={13} color={colors.live} />
              <Text style={styles.stripName}>{project.name}</Text>
              <View style={{ transform: [{ rotate: '90deg' }] }}>
                <Icon name="IconChevron" size={10} color={colors.inkFaint} />
              </View>
            </Pressable>
          ) : null}
          <View style={styles.composer}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={IDLE}
              placeholderTextColor={colors.inkFaint}
              multiline
              style={styles.input}
              selectionColor={colors.accent}
              keyboardAppearance="dark"
              editable={!starting}
            />
            <View style={styles.bar}>
              <View style={styles.yolo}>
                <Icon name={yolo ? 'IconShieldBolt' : 'IconShield'} size={13} color={yolo ? colors.accent : colors.inkFaint} />
                <Text style={[styles.yoloText, yolo && { color: '#c9a7ff' }]}>{yolo ? 'yolo' : 'safe'}</Text>
              </View>
              {launcher ? (
                <Pressable style={styles.picker} onPress={() => setSheet('agent')} accessibilityRole="button" accessibilityLabel="Agent">
                  <AgentIcon provider={launcher.provider} size={16} />
                  <Text style={styles.pickerText}>{launcher.label}</Text>
                  <View style={{ transform: [{ rotate: '90deg' }], opacity: 0.6 }}>
                    <Icon name="IconChevron" size={10} color={colors.accent} />
                  </View>
                </Pressable>
              ) : null}
              <View style={{ flex: 1 }} />
              <Pressable onPress={start} style={[styles.send, (!draft.trim() || starting) && { opacity: 0.28 }]} accessibilityRole="button" accessibilityLabel="Start">
                {starting ? <Working /> : <Icon name="IconArrowUp" size={16} color={colors.ground} />}
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
      <AgentSheet
        visible={sheet === 'agent'}
        onClose={() => setSheet(undefined)}
        launchers={workspace?.launchers ?? []}
        chosen={launcher}
        onChoose={(next) => {
          setLauncherId(next.id);
          setSheet(undefined);
        }}
      />
      <ProjectSheet
        visible={sheet === 'project'}
        onClose={() => setSheet(undefined)}
        projects={workspace?.projects ?? []}
        chosen={project}
        onChoose={(next) => {
          setProjectId(next.id);
          setSheet(undefined);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 28, borderTopWidth: 1, borderTopColor: colors.border },
  welcomeTitle: { fontFamily: fonts.uiSemibold, fontSize: 20, letterSpacing: -0.55, color: colors.ink },
  problem: { fontFamily: fonts.ui, fontSize: 13.5, color: colors.danger, textAlign: 'center' },
  wrap: { paddingHorizontal: 10, paddingTop: 8 },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginHorizontal: 14,
    marginBottom: -1,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.border,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    backgroundColor: colors.composer,
  },
  stripName: { fontFamily: fonts.uiMedium, fontSize: 13.5, color: colors.ink },
  composer: { padding: 6, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.composer },
  input: { minHeight: 44, maxHeight: 160, paddingHorizontal: 10, paddingTop: 9, paddingBottom: 4, fontFamily: fonts.ui, fontSize: 16, lineHeight: 22, color: colors.ink },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingTop: 6 },
  yolo: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 34, paddingHorizontal: 8 },
  yoloText: { fontFamily: fonts.uiSemibold, fontSize: 11, letterSpacing: 0.9, textTransform: 'uppercase', color: colors.inkFaint },
  picker: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 7 },
  pickerText: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.accent },
  send: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },

  scrim: { flex: 1, backgroundColor: 'rgba(9, 9, 11, 0.62)' },
  sheet: { backgroundColor: colors.overlay, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: colors.border, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: colors.borderStrong, marginBottom: 12 },
  sheetLabel: { fontFamily: fonts.uiSemibold, fontSize: 13, color: colors.tertiary, paddingTop: 14, paddingBottom: 8, paddingHorizontal: 6 },
  agents: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  agent: { width: '23.6%', height: 66, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, alignItems: 'center', justifyContent: 'center', gap: 6 },
  agentOn: { backgroundColor: colors.active, borderColor: colors.borderStrong },
  agentText: { fontFamily: fonts.ui, fontSize: 12, color: colors.tertiary },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 44, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.sunken },
  searchInput: { flex: 1, fontFamily: fonts.ui, fontSize: 15.5, color: colors.ink },
  group: { borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, overflow: 'hidden' },
  project: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingHorizontal: 14, paddingVertical: 8 },
  divided: { borderTopWidth: 1, borderTopColor: colors.border },
  projectName: { fontFamily: fonts.uiMedium, fontSize: 15, color: colors.secondary },
  projectPath: { fontFamily: fonts.mono, fontSize: 11.5, color: colors.tertiary, marginTop: 1 },
});
