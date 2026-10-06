import { memo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toolDiff } from '@mac/chat/diff';
import { pickerSlots, sessionConfigs, type SessionConfig } from '@mac/chat/sessionConfig';
import { toolKind, toolLabel, toolPath } from '@mac/chat/toolLabels';
import type { AcpAvailableCommand, AcpPermissionRequest, AcpToolCall, ChatState } from '@mac/chat/types';
import { providerName } from '@/devices/words';
import { haptics } from '@/ui/haptics';
import { AgentIcon, Icon, isProvider } from '@/ui/Icon';
import { Track } from '@/ui/controls';
import { useKeyboardShown } from '@/ui/screen';
import { Sheet } from '@/ui/Sheet';
import { brand, fonts, type Palette, useColors, useStyles } from '@/ui/theme';
import { ComposerAttachments } from './Attachments';
import { ComposerInput } from './ComposerInput';
import { pickFiles, pickPhotos } from './pick';
import { MAX_ATTACHMENTS, type Attachment, type ChatSession } from './session';
import { useDraft } from './useChat';

function current(config?: SessionConfig): string | undefined {
  if (!config) return undefined;
  return config.options.find((option) => option.value === config.currentValue)?.label ?? config.currentValue;
}

export function askTitle(request: AcpPermissionRequest): string {
  const kind = toolKind(request.toolCall);
  if (kind === 'run') return 'Run a command?';
  if (kind === 'edit' || kind === 'move' || kind === 'delete') return 'Change a file?';
  if (kind === 'fetch') return 'Open a web page?';
  return 'Allow this?';
}

/** All of what the agent asks to run or touch, since the end of a command can change what it does. */
function asked(tool: AcpToolCall): string {
  const command = (tool.rawInput as { command?: unknown } | undefined)?.command;
  if (typeof command === 'string' && command.trim()) return command.trim();
  if (Array.isArray(command) && command.every((word) => typeof word === 'string')) return command.join(' ');
  return toolPath(tool) ?? toolLabel(tool.title).name.trim();
}

/**
 * Sits above the composer until it is answered: the Mac's permission card, with the agent's own
 * options, and Cancel when none of them says no.
 */
function PermissionDock({
  request,
  provider,
  busy,
  onAnswer,
}: {
  request: AcpPermissionRequest;
  provider: string;
  busy: boolean;
  onAnswer: (optionId: string | null) => void;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const rejects = request.options.filter((option) => option.kind.startsWith('reject'));
  const always = request.options.filter((option) => option.kind === 'allow_always');
  const once = request.options.filter((option) => option.kind === 'allow_once');
  const cancel = rejects.length ? [] : [{ optionId: '', name: 'Cancel', kind: 'reject_once' }];
  const ordered = [...cancel, ...rejects, ...always, ...once];
  const primary = once[0] ?? always[0];
  const run = toolKind(request.toolCall) === 'run';
  const diff = toolDiff(request.toolCall);
  const title = askTitle(request);
  return (
    <View
      style={styles.dock}
      accessibilityRole="alert"
      accessibilityLabel={`${title} ${providerName(provider)} needs permission to continue`}>
      <View style={styles.dockHead}>
        <Icon name="IconShieldBolt" size={16} color={colors.ink} />
        <View style={{ flex: 1 }}>
          <Text style={styles.dockTitle}>{title}</Text>
          <Text style={styles.dockDetail}>{providerName(provider)} needs permission to continue</Text>
        </View>
      </View>
      <ScrollView style={styles.dockCmd} contentContainerStyle={styles.dockCmdPad} nestedScrollEnabled>
        <Text style={styles.dockCmdText} selectable>
          {run ? <Text style={{ color: colors.toolRun }}>$ </Text> : null}
          {asked(request.toolCall)}
        </Text>
        {diff ? (
          <Text style={[styles.dockCmdText, { marginTop: 4 }]}>
            <Text style={{ color: colors.gitAdded }}>+{diff.adds}</Text> <Text style={{ color: colors.gitDeleted }}>−{diff.dels}</Text>
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.dockActs}>
        {ordered.map((option) => {
          const go = option === primary;
          return (
            <Pressable
              key={option.optionId || option.name}
              disabled={busy}
              onPress={() => {
                haptics.select();
                onAnswer(option.optionId || null);
              }}
              style={({ pressed }) => [styles.act, go && styles.actGo, pressed && { opacity: 0.8 }, busy && { opacity: 0.5 }]}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy, busy }}>
              <Text
                style={[styles.actText, go && styles.actGoText, option.kind.startsWith('reject') && { color: colors.secondary }]}
                numberOfLines={1}>
                {option.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** The agent's slash commands that start with what is typed, while only a command is typed. */
function Commands({ commands, typed, onPick }: { commands: AcpAvailableCommand[]; typed: string; onPick: (name: string) => void }) {
  const styles = useStyles(makeStyles);
  const prefix = /^\/(\S*)$/.exec(typed)?.[1];
  if (prefix === undefined) return null;
  const matches = commands.filter((command) => command.name.startsWith(prefix)).slice(0, 6);
  if (!matches.length) return null;
  return (
    <View style={styles.commands} accessibilityRole="menu">
      {matches.map((command) => (
        <Pressable
          key={command.name}
          onPress={() => onPick(command.name)}
          style={({ pressed }) => [styles.command, pressed && { opacity: 0.8 }]}
          accessibilityRole="menuitem"
          accessibilityLabel={`/${command.name}, ${command.description}`}>
          <Text style={styles.commandName}>/{command.name}</Text>
          <Text style={styles.commandText} numberOfLines={1}>
            {command.description}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function ConfigSheet({
  visible,
  onClose,
  provider,
  configs,
  usage,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  provider: string;
  configs: SessionConfig[];
  usage: ChatState['usage'];
  onPick: (config: SessionConfig, value: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const slots = pickerSlots(configs, provider as never);
  const model = slots[0]?.config;
  const effort = slots[1]?.config;
  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={styles.sheetHead}>
        <AgentIcon provider={provider} size={20} />
        <Text style={styles.sheetTitle}>{providerName(provider)}</Text>
      </View>
      {model ? (
        <>
          <Text style={styles.sheetLabel}>Model</Text>
          <View style={styles.group}>
            {model.options.map((option, index) => {
              const on = option.value === model.currentValue;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => onPick(model, option.value)}
                  style={[styles.option, on && { backgroundColor: colors.active }, index > 0 && styles.optionDivided]}>
                  <AgentIcon provider={provider} size={18} />
                  <Text style={[styles.optionText, on && { color: colors.ink }]} numberOfLines={1}>
                    {option.label}
                  </Text>
                  {on ? <Icon name="IconCheck" size={17} color={colors.ink} /> : null}
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}
      {effort ? (
        <>
          <Text style={styles.sheetLabel}>Effort</Text>
          <Track
            value={effort.currentValue}
            onChange={(value) => onPick(effort, value)}
            options={effort.options.map((option) => ({ value: option.value, label: option.label }))}
          />
        </>
      ) : null}
      {usage ? (
        <View style={styles.context}>
          <View style={styles.contextTop}>
            <Text style={styles.contextLabel}>Context</Text>
            <Text style={styles.contextValue}>
              {Math.round(usage.used / 1000)}k of {Math.round(usage.size / 1000)}k
            </Text>
          </View>
          <View style={styles.contextBar}>
            <View
              style={[
                styles.contextFill,
                {
                  width: `${Math.min(100, (usage.used / usage.size) * 100)}%`,
                  backgroundColor: isProvider(provider) ? brand[provider] : colors.accent,
                },
              ]}
            />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

type Source = 'photos' | 'files';

/** Where a message's photos and files come from. */
function AttachSheet({
  visible,
  onClose,
  onPick,
  onDismiss,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (source: Source) => void;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const sources: { source: Source; label: string; icon: 'IconImage' | 'IconFile' }[] = [
    { source: 'photos', label: 'Photos', icon: 'IconImage' },
    { source: 'files', label: 'Files', icon: 'IconFile' },
  ];
  return (
    <Sheet visible={visible} onClose={onClose} onDismiss={onDismiss}>
      <View style={styles.sources}>
        {sources.map(({ source, label, icon }) => (
          <Pressable
            key={source}
            onPress={() => onPick(source)}
            style={({ pressed }) => [styles.source, pressed && { backgroundColor: colors.active }]}
            accessibilityRole="button">
            <Icon name={icon} size={19} color={colors.ink} />
            <Text style={styles.sourceText}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

export const Composer = memo(function Composer({
  session,
  provider,
  running,
  setup,
  usage,
  commands,
  request,
  answering,
  placeholder,
  permissionMode,
  watchOnly,
  offline,
  hostName,
  onSent,
  attachments,
}: {
  session: ChatSession;
  provider: string;
  running: boolean;
  setup: ChatState['setup'];
  usage: ChatState['usage'];
  commands: AcpAvailableCommand[];
  /** The permission request to answer first, if any. */
  request: AcpPermissionRequest | undefined;
  answering: boolean;
  placeholder: string;
  permissionMode: string;
  watchOnly: boolean;
  /** The host is out of reach, so a message is kept until it is back. */
  offline: boolean;
  hostName: string;
  onSent: () => void;
  /** Picked for the next message. */
  attachments: readonly Attachment[];
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const draft = useDraft(session);
  const [adding, setAdding] = useState(false);
  const source = useRef<Source | null>(null);
  const uploading = attachments.some((attachment) => attachment.upload === 'sending');
  const room = MAX_ATTACHMENTS - attachments.length;
  const [focused, setFocused] = useState(false);
  const input = useRef<TextInput>(null);
  const [sheet, setSheet] = useState(false);
  const typing = useKeyboardShown();
  const configs = sessionConfigs(setup);
  const slots = pickerSlots(configs, provider as never);
  const model = current(slots[0]?.config);
  const effort = current(slots[1]?.config);
  const yolo = permissionMode === 'bypass' || permissionMode === 'bypassPermissions' || permissionMode === 'full-access';
  const dock = request ? (
    <PermissionDock
      request={request}
      provider={provider}
      busy={answering}
      onAnswer={(option) => session.answer(request.requestId, option)}
    />
  ) : null;

  if (watchOnly) {
    return (
      <SafeAreaView edges={typing ? [] : ['bottom']} style={styles.wrap}>
        {dock}
        <View style={[styles.composer, styles.watch]}>
          <Icon name="IconEye" size={17} color={colors.inkDim} />
          <Text style={styles.watchText}>
            Watching. This phone can answer permission requests on {hostName}; the host can give it full access.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const sendable = Boolean(draft.trim()) || attachments.length > 0;
  const send = () => {
    const text = draft.trim();
    if (!sendable || offline || uploading) return;
    haptics.tap();
    void session.send(text).then((sent) => {
      if (!sent) return;
      // Clearing the state alone leaves text the keyboard is still composing.
      input.current?.clear();
      session.setDraft('');
      onSent();
    });
  };

  const pick = (from: Source) => {
    const picking = from === 'photos' ? pickPhotos(room) : pickFiles(room);
    picking
      .then(session.attach)
      .catch((error: unknown) => session.report(`could not pick: ${error instanceof Error ? error.message : String(error)}`));
  };
  // iOS shows a picker only once the sheet over the screen has gone.
  const choose = (from: Source) => {
    setAdding(false);
    if (Platform.OS === 'ios') source.current = from;
    else pick(from);
  };
  const dismissed = () => {
    const from = source.current;
    source.current = null;
    if (from) pick(from);
  };

  return (
    <SafeAreaView edges={typing ? [] : ['bottom']} style={styles.wrap}>
      {dock}
      <Commands commands={commands} typed={draft} onPick={(name) => session.setDraft(`/${name} `)} />
      <View style={[styles.composer, focused && { borderColor: colors.borderSelected }]}>
        {attachments.length ? <ComposerAttachments attachments={attachments} onRemove={session.removeAttachment} onRetry={send} /> : null}
        <ComposerInput
          ref={input}
          value={draft}
          editable={!uploading}
          onChangeText={session.setDraft}
          placeholder={placeholder}
          accessibilityLabel="Message"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <View style={styles.bar}>
          <Pressable
            onPress={() => setAdding(true)}
            disabled={uploading || room <= 0}
            style={({ pressed }) => [
              styles.add,
              pressed && { backgroundColor: colors.active },
              (uploading || room <= 0) && { opacity: 0.4 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Add photos or files"
            accessibilityState={{ disabled: uploading || room <= 0 }}>
            <Icon name="IconPlus" size={17} color={colors.inkDim} />
          </Pressable>
          <View style={styles.yolo} accessible accessibilityLabel={yolo ? 'Runs without asking' : 'Asks before acting'}>
            <Icon name={yolo ? 'IconShieldBolt' : 'IconShield'} size={13} color={yolo ? colors.accent : colors.inkFaint} />
            <Text style={[styles.yoloText, yolo && { color: colors.accent }]}>{yolo ? 'yolo' : 'safe'}</Text>
          </View>
          {model ? (
            <Pressable
              style={styles.picker}
              onPress={() => setSheet(true)}
              accessibilityRole="button"
              accessibilityLabel={`Model, ${model}`}>
              <AgentIcon provider={provider} size={16} />
              <Text style={[styles.pickerText, { color: colors.accent }]} numberOfLines={1}>
                {model}
              </Text>
              <View style={{ transform: [{ rotate: '90deg' }], opacity: 0.6 }}>
                <Icon name="IconChevron" size={10} color={colors.accent} />
              </View>
            </Pressable>
          ) : null}
          {effort ? (
            <Pressable
              style={styles.picker}
              onPress={() => setSheet(true)}
              accessibilityRole="button"
              accessibilityLabel={`Effort, ${effort}`}>
              <Text style={styles.pickerText}>{effort}</Text>
              <View style={{ transform: [{ rotate: '90deg' }], opacity: 0.6 }}>
                <Icon name="IconChevron" size={10} color={colors.inkDim} />
              </View>
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }} />
          {sendable || !running ? (
            <Pressable
              onPress={send}
              style={[styles.send, (!sendable || offline) && { opacity: 0.28 }]}
              disabled={offline || uploading}
              accessibilityRole="button"
              accessibilityLabel={
                uploading ? 'Sending files' : offline ? `Send, waiting for ${hostName}` : running ? 'Send after this turn' : 'Send'
              }
              accessibilityState={{ disabled: offline || !sendable, busy: uploading }}>
              {uploading ? (
                <ActivityIndicator size="small" color={colors.ground} />
              ) : (
                <Icon name="IconArrowUp" size={16} color={colors.ground} />
              )}
            </Pressable>
          ) : (
            <Pressable onPress={session.cancel} style={styles.send} accessibilityRole="button" accessibilityLabel="Stop">
              <View style={styles.stop} />
            </Pressable>
          )}
        </View>
      </View>
      <AttachSheet visible={adding} onClose={() => setAdding(false)} onPick={choose} onDismiss={dismissed} />
      <ConfigSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        provider={provider}
        configs={configs}
        usage={usage}
        onPick={(config, value) => {
          session.setConfig(config.id, value);
          setSheet(false);
        }}
      />
    </SafeAreaView>
  );
});

const makeStyles = (colors: Palette) => {
  return StyleSheet.create({
    wrap: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6 },
    composer: { padding: 6, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.composer },
    bar: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingTop: 6 },
    add: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
    yolo: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 34, paddingHorizontal: 8 },
    yoloText: { fontFamily: fonts.uiSemibold, fontSize: 11, letterSpacing: 0.9, textTransform: 'uppercase', color: colors.inkFaint },
    picker: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 7, borderRadius: 7, maxWidth: 160 },
    pickerText: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.inkDim },
    send: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
    stop: { width: 10, height: 10, borderRadius: 2, backgroundColor: colors.ground },
    watch: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 },
    watchText: { flex: 1, fontFamily: fonts.ui, fontSize: 13.5, lineHeight: 19, color: colors.inkDim },

    dock: {
      marginBottom: 8,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 16,
      backgroundColor: colors.overlay,
    },
    dockHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    dockTitle: { fontFamily: fonts.uiSemibold, fontSize: 15, letterSpacing: -0.2, color: colors.ink },
    dockDetail: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.tertiary, marginTop: 1 },
    dockCmd: {
      marginTop: 10,
      maxHeight: 150,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.sunken,
    },
    dockCmdPad: { paddingVertical: 9, paddingHorizontal: 11 },
    dockCmdText: { fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 18, color: colors.ink },
    dockActs: { flexDirection: 'row', gap: 6, marginTop: 10 },
    act: {
      flex: 1,
      minHeight: 38,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
    },
    actGo: { backgroundColor: colors.ink, borderColor: colors.ink },
    actText: { fontFamily: fonts.uiMedium, fontSize: 14, color: colors.ink },
    actGoText: { fontFamily: fonts.uiSemibold, color: colors.ground },

    commands: { gap: 4, marginBottom: 8 },
    command: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      minHeight: 40,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.overlay,
    },
    commandName: { fontFamily: fonts.mono, fontSize: 13, color: colors.accent },
    commandText: { flex: 1, fontFamily: fonts.ui, fontSize: 13, color: colors.tertiary },

    sources: { gap: 8, paddingBottom: 4 },
    source: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 52,
      paddingHorizontal: 14,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.raised,
    },
    sourceText: { fontFamily: fonts.uiMedium, fontSize: 15.5, color: colors.ink },
    sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 },
    sheetTitle: { fontFamily: fonts.uiSemibold, fontSize: 17, letterSpacing: -0.35, color: colors.ink },
    sheetLabel: {
      fontFamily: fonts.uiSemibold,
      fontSize: 13,
      color: colors.tertiary,
      paddingTop: 18,
      paddingBottom: 8,
      paddingHorizontal: 6,
    },
    group: { borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised, overflow: 'hidden' },
    option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 14 },
    optionDivided: { borderTopWidth: 1, borderTopColor: colors.border },
    optionText: { flex: 1, fontFamily: fonts.uiMedium, fontSize: 15.5, color: colors.secondary },
    context: { marginTop: 20, paddingHorizontal: 4 },
    contextTop: { flexDirection: 'row', justifyContent: 'space-between' },
    contextLabel: { fontFamily: fonts.uiSemibold, fontSize: 13, color: colors.tertiary },
    contextValue: { fontFamily: fonts.mono, fontSize: 12, color: colors.tertiary },
    contextBar: { marginTop: 8, height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: 'hidden' },
    contextFill: { height: 4, borderRadius: 2 },
  });
};
