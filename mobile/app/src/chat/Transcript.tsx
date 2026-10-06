import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Animated, Easing, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { collapseDiff } from '@mac/chat/diff';
import { durationLabel } from '@mac/chat/durationLabel';
import { toolKind, toolRunning, toolTarget } from '@mac/chat/toolLabels';
import type { AcpContentBlock, ChatMessage, ChatPart } from '@mac/chat/types';
import { AgentIcon, Icon } from '@/ui/Icon';
import type { IconName } from '@/ui/icons.generated';
import { Working } from '@/ui/status';
import { fonts, type Palette, useColors, useStyles } from '@/ui/theme';
import { Folds } from './folds';
import { Markdown } from './Markdown';
import type { Unsent } from './session';

/** Where the transcript keeps which tool groups and rows are open. */
export const FoldsContext = createContext(new Folds());

function useFold(id: string, otherwise: boolean): [boolean, (open: boolean) => void] {
  const folds = useContext(FoldsContext);
  const open = useSyncExternalStore(folds.subscribe, () => folds.isOpen(id, otherwise));
  return [open, (next) => folds.set(id, next)];
}

/** Lines of a change shown under its row; the host's diff view has the rest. */
const DIFF_ROWS = 120;

type ToolPart = Extract<ChatPart, { kind: 'tool' }>;

/** The verb, icon and colour of each kind of call, as the Mac's tool rows draw them. */
function look(kind: string, colors: Palette): { icon: IconName; color: string } {
  switch (kind) {
    case 'run':
      return { icon: 'IconCommand', color: colors.toolRun };
    case 'read':
      return { icon: 'IconFile', color: colors.toolRead };
    case 'search':
      return { icon: 'IconSearch', color: colors.toolRead };
    case 'fetch':
      return { icon: 'IconGlobe', color: colors.toolRead };
    case 'edit':
    case 'move':
      return { icon: 'IconPencil', color: colors.toolEdit };
    case 'delete':
      return { icon: 'IconPencil', color: colors.toolDelete };
    default:
      return { icon: 'IconAgent', color: colors.inkDim };
  }
}

/** Scrolls both ways inside the transcript, so long output keeps to a few lines of the screen. */
function DetailBox({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <ScrollView style={styles.detailBox} nestedScrollEnabled>
      <ScrollView horizontal contentContainerStyle={styles.detailPad}>
        {children}
      </ScrollView>
    </ScrollView>
  );
}

function ToolDetail({ part }: { part: ToolPart }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const diff = part.diff ? collapseDiff(part.diff.lines, 2) : null;
  const shown = diff?.rows.slice(0, DIFF_ROWS) ?? [];
  const more = (diff?.rows.length ?? 0) - shown.length;
  return (
    <View style={styles.detail}>
      {part.failure ? (
        <Text style={[styles.detailText, { color: colors.danger }]} selectable>
          {part.failure}
        </Text>
      ) : null}
      {diff ? (
        <DetailBox>
          <View>
            {shown.map((row, index) =>
              'gap' in row ? (
                <Text key={index} style={[styles.detailText, { color: colors.inkFaint }]}>
                  ⋯ {row.gap} unchanged line{row.gap === 1 ? '' : 's'}
                </Text>
              ) : (
                <Text
                  key={index}
                  style={[
                    styles.detailText,
                    row.sign === '+' && { color: colors.gitAdded },
                    row.sign === '-' && { color: colors.gitDeleted },
                  ]}
                  selectable>
                  {row.sign} {row.text}
                </Text>
              ),
            )}
            {more > 0 ? <Text style={[styles.detailText, { color: colors.inkFaint }]}>{more} more lines on the host</Text> : null}
          </View>
        </DetailBox>
      ) : null}
      {part.output?.text ? (
        <DetailBox>
          <Text style={styles.detailText} selectable>
            {part.output.text}
            {part.output.cut ? '\n…' : ''}
          </Text>
        </DetailBox>
      ) : null}
      {part.output?.image ? (
        <Image
          source={{ uri: `data:${part.output.image.mimeType};base64,${part.output.image.data}` }}
          style={styles.image}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}

function ToolRow({ part, last, untimed, group }: { part: ToolPart; last: boolean; untimed: boolean; group: string }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const kind = toolKind(part.tool);
  const { icon, color } = look(kind, colors);
  const failed = part.tool.status === 'failed';
  const running = toolRunning(part.tool);
  const spent =
    !untimed && part.startedAt && part.endedAt && part.endedAt > part.startedAt ? durationLabel(part.endedAt - part.startedAt) : null;
  const opens = !!(part.failure || part.diff || part.output?.text || part.output?.image);
  const [open, setOpen] = useFold(`${group}/${part.id}`, false);
  const target = toolTarget(part.tool);
  return (
    <View>
      <Pressable
        style={styles.tool}
        onPress={opens ? () => setOpen(!open) : undefined}
        disabled={!opens}
        accessibilityRole={opens ? 'button' : undefined}
        accessibilityLabel={`${kind} ${target}${failed ? ', failed' : running ? ', running' : ''}`}
        accessibilityState={opens ? { expanded: open } : undefined}>
        <View style={last && !open ? styles.elbow : styles.spine} />
        <View style={[styles.tick, last && !open && { backgroundColor: 'transparent' }]} />
        <Icon name={failed ? 'IconWarning' : icon} size={12} color={failed ? colors.danger : color} />
        <Text style={[styles.kind, { color: failed ? colors.danger : color }]}>{kind}</Text>
        <Text style={[styles.target, running && { color: colors.inkDim }]} numberOfLines={1}>
          {target}
        </Text>
        <View style={styles.toolEnd}>
          {part.diff ? (
            <Text style={styles.endText}>
              <Text style={{ color: colors.gitAdded }}>+{part.diff.adds}</Text>{' '}
              <Text style={{ color: colors.gitDeleted }}>−{part.diff.dels}</Text>
            </Text>
          ) : null}
          {!part.diff && spent ? <Text style={styles.endText}>{spent}</Text> : null}
        </View>
      </Pressable>
      {open ? (
        <View style={styles.detailRow}>
          {last ? null : <View style={styles.spine} />}
          <ToolDetail part={part} />
        </View>
      ) : null}
    </View>
  );
}

function ToolGroup({ id, parts, untimed }: { id: string; parts: ToolPart[]; untimed: boolean }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const working = parts.some((part) => toolRunning(part.tool));
  const [open, setOpen] = useFold(id, working);
  const started = parts[0]?.startedAt;
  const ended = parts[parts.length - 1]?.endedAt;
  return (
    <View style={styles.tools}>
      <Pressable
        onPress={() => setOpen(!open)}
        style={styles.summary}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${parts.length} tool call${parts.length === 1 ? '' : 's'}${working ? ', running' : ''}`}
        accessibilityState={{ expanded: open }}>
        <Text style={styles.summaryText}>
          {parts.length} tool call{parts.length === 1 ? '' : 's'}
        </Text>
        {!untimed && started && ended && ended > started ? <Text style={styles.summaryTime}>{durationLabel(ended - started)}</Text> : null}
        <View style={[styles.summaryChevron, open && { transform: [{ rotate: '90deg' }] }]}>
          <Icon name="IconChevron" size={11} color={colors.inkDim} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.toolsBody}>
          {parts.map((part, index) => (
            <ToolRow key={part.id} part={part} last={index === parts.length - 1} untimed={untimed} group={id} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function userText(message: ChatMessage): string {
  return message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');
}

function Assistant({ message, untimed }: { message: ChatMessage; untimed: boolean }) {
  const styles = useStyles(makeStyles);
  const runs: (ChatPart | ToolPart[])[] = [];
  for (const part of message.parts) {
    const previous = runs[runs.length - 1];
    if (part.kind === 'tool') {
      if (Array.isArray(previous)) previous.push(part);
      else runs.push([part]);
    } else runs.push(part);
  }
  return (
    <>
      {runs.map((run, index) => {
        if (Array.isArray(run)) return <ToolGroup key={run[0].id} id={`${message.id}/${run[0].id}`} parts={run} untimed={untimed} />;
        switch (run.kind) {
          case 'text':
            return run.text.trim() ? <Markdown key={run.id} text={run.text} style={styles.prose} /> : null;
          case 'thought':
            return run.text.trim() ? (
              <Text key={run.id} style={styles.thought}>
                {run.text.trim()}
              </Text>
            ) : null;
          case 'subagent':
            return (
              <Text key={run.id} style={styles.note}>
                {run.subagent.name} · {run.subagent.state}
              </Text>
            );
          case 'notice':
            return (
              <Text key={run.id} style={styles.note}>
                {run.notice.name} {run.notice.state}
              </Text>
            );
          case 'content':
            return <Content key={run.id} block={run.content} />;
          default:
            return <View key={index} />;
        }
      })}
    </>
  );
}

/** An image or file the agent put in its answer. */
function Content({ block }: { block: AcpContentBlock }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  if (block.type === 'text' && block.text?.trim()) return <Markdown text={block.text} style={styles.prose} />;
  if (block.type === 'image' && block.data && block.mimeType?.startsWith('image/')) {
    return (
      <Image
        source={{ uri: `data:${block.mimeType};base64,${block.data}` }}
        style={styles.image}
        resizeMode="contain"
        accessibilityLabel="Image from the agent"
        accessibilityIgnoresInvertColors
      />
    );
  }
  const resource = typeof block.resource === 'object' && block.resource !== null ? (block.resource as { uri?: unknown }) : null;
  const uri = block.uri ?? (typeof resource?.uri === 'string' ? resource.uri : undefined);
  const name = block.title ?? block.name ?? uri?.split('/').pop();
  if (!name) return null;
  return (
    <View style={styles.resource} accessible accessibilityLabel={`File ${name}`}>
      <Icon name={block.mimeType?.startsWith('image/') ? 'IconImage' : 'IconFile'} size={14} color={colors.inkDim} />
      <Text style={styles.resourceText} numberOfLines={1} selectable>
        {name}
      </Text>
    </View>
  );
}

export function Message({
  message,
  untimed = false,
  unsent,
  onRetry,
}: {
  message: ChatMessage;
  untimed?: boolean;
  unsent?: Unsent;
  onRetry?: (messageId: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  if (message.role === 'user') {
    const failed = unsent?.state === 'failed';
    return (
      <View style={styles.userRow}>
        <View style={[styles.bubble, unsent?.state === 'sending' && { opacity: 0.7 }, failed && styles.failedBubble]}>
          <Text style={styles.userText} selectable>
            {userText(message)}
          </Text>
        </View>
        {failed ? (
          <Pressable
            onPress={() => onRetry?.(message.id)}
            hitSlop={10}
            style={styles.unsent}
            accessibilityRole="button"
            accessibilityLabel={`Not sent${unsent?.problem ? `: ${unsent.problem}` : ''}. Retry`}>
            <Icon name="IconWarning" size={12} color={colors.danger} />
            <Text style={[styles.unsentText, { color: colors.danger }]}>Not sent</Text>
            <Text style={styles.unsentText}>·</Text>
            <Text style={[styles.unsentText, { color: colors.ink }]}>Retry</Text>
          </Pressable>
        ) : unsent?.state === 'sending' ? (
          <Text style={styles.queuedLabel}>Sending…</Text>
        ) : null}
      </View>
    );
  }
  return <Assistant message={message} untimed={untimed} />;
}

export function Queued({ text }: { text: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.userRow}>
      <View style={[styles.bubble, { opacity: 0.55 }]}>
        <Text style={styles.userText}>{text}</Text>
      </View>
      <Text style={styles.queuedLabel}>Sends when this turn ends</Text>
    </View>
  );
}

/** Above the first message while the host has turns from before it, which arrive as it comes into view. */
export function Earlier({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  if (failed) {
    return (
      <Pressable
        onPress={onRetry}
        style={styles.earlier}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Couldn't load earlier messages. Retry">
        <Text style={styles.earlierText}>{"Couldn't load earlier messages ·"}</Text>
        <Text style={[styles.earlierText, styles.retry]}>Retry</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.earlier}>
      <Working />
      <Text style={styles.earlierText}>Loading earlier messages…</Text>
    </View>
  );
}

/** The working line: the agent's logo breathing beside what it is doing, and for how long. */
export function Activity({ provider, label, since }: { provider: string; label: string; since: number }) {
  const styles = useStyles(makeStyles);
  const [breath] = useState(() => new Animated.Value(1));
  const [seconds, setSeconds] = useState(() => Math.round((Date.now() - since) / 1000));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 0.5, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(breath, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    const tick = setInterval(() => setSeconds(Math.round((Date.now() - since) / 1000)), 1000);
    return () => {
      loop.stop();
      clearInterval(tick);
    };
  }, [breath, since]);
  return (
    <View style={styles.activity} accessible accessibilityLabel={label}>
      <Animated.View style={{ opacity: breath }}>
        <AgentIcon provider={provider} size={20} />
      </Animated.View>
      <Text style={styles.activityText}>{label}</Text>
      {seconds > 0 ? <Text style={styles.activityTime}>{durationLabel(seconds * 1000)}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: Palette) => {
  return StyleSheet.create({
    userRow: { alignItems: 'flex-end', marginTop: 14, marginBottom: 6 },
    bubble: {
      maxWidth: '84%',
      paddingVertical: 9,
      paddingHorizontal: 13,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.raised,
    },
    userText: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 22, color: colors.ink },
    failedBubble: { borderColor: colors.danger },
    unsent: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
    unsentText: { fontFamily: fonts.uiMedium, fontSize: 12, color: colors.inkFaint },
    image: { width: '100%', aspectRatio: 4 / 3, borderRadius: 8, marginVertical: 6, backgroundColor: colors.sunken },
    resource: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      alignSelf: 'flex-start',
      maxWidth: '100%',
      marginVertical: 6,
      paddingVertical: 7,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.raised,
    },
    resourceText: { flexShrink: 1, fontFamily: fonts.mono, fontSize: 12, color: colors.ink },
    detailRow: { flexDirection: 'row' },
    detail: { flex: 1, gap: 6, marginLeft: 18, marginVertical: 4 },
    detailBox: { maxHeight: 260, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.sunken },
    detailPad: { padding: 9 },
    detailText: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, color: colors.secondary },
    retry: { color: colors.ink, fontFamily: fonts.uiMedium },
    queuedLabel: { fontFamily: fonts.ui, fontSize: 11, color: colors.inkFaint, marginTop: 4 },
    prose: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 23, color: colors.ink },
    thought: { fontFamily: fonts.uiItalic, fontSize: 12.5, lineHeight: 19.5, color: colors.inkFaint, marginVertical: 8 },
    note: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.inkDim, marginVertical: 6 },
    tools: { marginVertical: 6 },
    summary: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26, alignSelf: 'flex-start' },
    summaryText: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.inkDim },
    summaryTime: { fontFamily: fonts.mono, fontSize: 11, color: colors.inkDim },
    summaryChevron: { opacity: 0.7 },
    toolsBody: { marginLeft: 6, paddingVertical: 2 },
    tool: { flexDirection: 'row', alignItems: 'center', minHeight: 26, gap: 8 },
    spine: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 1, backgroundColor: colors.treeSpine },
    // The last row's spine bends into its tick, ending on the row's middle like the Mac's.
    elbow: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: '50%',
      width: 10,
      marginBottom: -0.5,
      borderLeftWidth: 1,
      borderBottomWidth: 1,
      borderBottomLeftRadius: 4,
      borderLeftColor: colors.treeSpine,
      borderBottomColor: colors.treeTick,
    },
    tick: { width: 10, height: 1, backgroundColor: colors.treeTick },
    kind: { fontFamily: fonts.mono, fontSize: 11.5 },
    target: { flex: 1, fontFamily: fonts.mono, fontSize: 11.5, color: colors.ink },
    toolEnd: { flexDirection: 'row', gap: 6 },
    endText: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.inkDim },
    earlier: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 10, paddingBottom: 6 },
    earlierText: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.tertiary },
    activity: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 14, marginBottom: 6 },
    activityText: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.inkFaint },
    activityTime: { fontFamily: fonts.mono, fontSize: 10, color: colors.inkFaint },
  });
};
