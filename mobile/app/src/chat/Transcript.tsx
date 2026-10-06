import { createContext, useContext, useEffect, useState } from 'react';
import { Animated, Easing, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { durationLabel } from '@mac/chat/durationLabel';
import { cutLongText } from '@mac/chat/longText';
import { subagentTask } from '@mac/chat/transcript';
import type { AcpContentBlock, AcpSubagent, AcpTaskNotice, ChatMessage, ChatPart } from '@mac/chat/types';
import { AgentIcon, Icon } from '@/ui/Icon';
import { Working } from '@/ui/status';
import { fonts, type Palette, translucent, useColors, useStyles } from '@/ui/theme';
import { FoldsContext, useFold } from './folds';
import { Markdown } from './Markdown';
import { SentAttachments } from './Attachments';
import type { Attachment, Held, Unsent } from './session';
import { ToolGroup, type ToolPart } from './Tools';

/** The chat's agent, whose mark its subagents carry. */
export const ProviderContext = createContext('agent');

/**
 * A message too long to draw at once shows its start and the rest on a tap, unless the person
 * watched it stream in.
 */
function LongText({ id, text, live, style }: { id: string; text: string; live: boolean; style: object }) {
  const styles = useStyles(makeStyles);
  const folds = useContext(FoldsContext);
  const [whole, setWhole] = useFold(`whole/${id}`, false);
  if (live) folds.streamed.add(id);
  const cut = whole || folds.streamed.has(id) ? null : cutLongText(text);
  return (
    <>
      <Markdown text={cut ? cut.head : text} style={style} />
      {cut ? (
        <Pressable onPress={() => setWhole(true)} hitSlop={6} style={styles.showRest} accessibilityRole="button">
          <Text style={styles.showRestText}>Show the rest · {Math.round(cut.hidden / 1000)}k more characters</Text>
        </Pressable>
      ) : null}
    </>
  );
}

const SUBAGENT_WORDS: Record<AcpSubagent['state'], string> = {
  running: 'working',
  completed: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  disconnected: 'lost',
};

function SubagentMark({ state }: { state: AcpSubagent['state'] }) {
  const colors = useColors();
  if (state === 'running') return <Working />;
  if (state === 'completed') return <Icon name="IconCheck" size={13} color={colors.live} />;
  if (state === 'failed') return <Icon name="IconWarning" size={12} color={colors.danger} />;
  if (state === 'disconnected') return <Icon name="IconPlug" size={12} color={colors.danger} />;
  return <Icon name="IconClose" size={11} color={colors.inkFaint} />;
}

/** What a subagent did, kept to one line until it is opened; what it is doing now is over the composer. */
function Subagent({ subagent, untimed }: { subagent: AcpSubagent; untimed: boolean }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const provider = useContext(ProviderContext);
  const [open, setOpen] = useFold(`subagent/${subagent.sessionId}`, false);
  const parts = subagent.messages.flatMap((message) => message.parts);
  const calls = parts.filter((part) => part.kind === 'tool').length;
  const running = subagent.state === 'running';
  return (
    <View style={styles.subagent}>
      <Pressable
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.subagentHead, pressed && { backgroundColor: colors.active }]}
        accessibilityRole="button"
        accessibilityLabel={`Subagent ${subagent.name}, ${SUBAGENT_WORDS[subagent.state]}${calls ? `, ${calls} calls` : ''}`}
        accessibilityState={{ expanded: open }}>
        <View style={[styles.chevron, open && { transform: [{ rotate: '90deg' }] }]}>
          <Icon name="IconChevron" size={10} color={colors.inkDim} />
        </View>
        <AgentIcon provider={provider} size={15} />
        <Text style={styles.subagentName} numberOfLines={1}>
          {subagent.name}
        </Text>
        <Text style={styles.subagentTask} numberOfLines={1}>
          {subagentTask(subagent.task)}
        </Text>
        {calls ? (
          <Text style={styles.subagentCalls}>
            {calls} {calls === 1 ? 'call' : 'calls'}
          </Text>
        ) : null}
        <View style={styles.subagentMark}>
          <SubagentMark state={subagent.state} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.subagentBody}>
          {parts.length ? (
            <Parts id={`subagent/${subagent.sessionId}`} parts={parts} untimed={untimed} live={running} />
          ) : (
            <Text style={styles.empty}>No output yet.</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** A background task that reached its end, and what it said of how it went. */
function Notice({ id, notice }: { id: string; notice: AcpTaskNotice }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const [open, setOpen] = useFold(`notice/${id}`, false);
  const summary = notice.summary?.trim();
  return (
    <Pressable
      onPress={summary ? () => setOpen(!open) : undefined}
      disabled={!summary}
      style={styles.notice}
      accessibilityRole={summary ? 'button' : undefined}
      accessibilityLabel={`${notice.name} ${notice.state}${summary ? `. ${summary}` : ''}`}
      accessibilityState={summary ? { expanded: open } : undefined}>
      <View style={styles.noticeHead}>
        <Icon name="IconTimer" size={12} color={notice.state === 'failed' ? colors.danger : colors.inkFaint} />
        <Text style={styles.noticeName} numberOfLines={1}>
          {notice.name}
        </Text>
        <Text style={[styles.noticeState, notice.state === 'failed' && { color: colors.danger }]}>{notice.state}</Text>
      </View>
      {summary ? (
        <Text style={styles.noticeSummary} numberOfLines={open ? undefined : 1} selectable={open}>
          {summary}
        </Text>
      ) : null}
    </Pressable>
  );
}

function userText(message: ChatMessage): string {
  return message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');
}

/** A message's parts in order, with each run of tool calls drawn as one group. */
function Parts({ id, parts, untimed, live }: { id: string; parts: ChatPart[]; untimed: boolean; live: boolean }) {
  const styles = useStyles(makeStyles);
  const runs: (ChatPart | ToolPart[])[] = [];
  for (const part of parts) {
    const previous = runs[runs.length - 1];
    if (part.kind === 'tool') {
      if (Array.isArray(previous)) previous.push(part);
      else runs.push([part]);
    } else runs.push(part);
  }
  return (
    <>
      {runs.map((run, index) => {
        const last = live && index === runs.length - 1;
        if (Array.isArray(run)) return <ToolGroup key={run[0].id} id={`${id}/${run[0].id}`} parts={run} untimed={untimed} live={last} />;
        switch (run.kind) {
          case 'text':
            return run.text.trim() ? <LongText key={run.id} id={run.id} text={run.text} live={last} style={styles.prose} /> : null;
          case 'thought':
            return run.text.trim() ? (
              <View key={run.id} style={styles.thought}>
                <LongText id={run.id} text={run.text.trim()} live={last} style={styles.thoughtText} />
              </View>
            ) : null;
          case 'subagent':
            return <Subagent key={run.id} subagent={run.subagent} untimed={untimed} />;
          case 'notice':
            return <Notice key={run.id} id={run.id} notice={run.notice} />;
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
  live = false,
  untimed = false,
  unsent,
  onRetry,
  sentFiles,
}: {
  message: ChatMessage;
  live?: boolean;
  untimed?: boolean;
  unsent?: Unsent;
  onRetry?: (messageId: string) => void;
  sentFiles: ReadonlyMap<string, Attachment>;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  if (message.role === 'user') {
    const failed = unsent?.state === 'failed';
    const text = userText(message);
    return (
      <View style={styles.userRow}>
        {message.attachments?.length ? <SentAttachments paths={message.attachments} sentFiles={sentFiles} /> : null}
        {text || !message.attachments?.length ? (
          <View style={[styles.bubble, unsent?.state === 'sending' && { opacity: 0.7 }, failed && styles.failedBubble]}>
            <Text style={styles.userText} selectable>
              {text}
            </Text>
          </View>
        ) : null}
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
  return <Parts id={message.id} parts={message.parts} untimed={untimed} live={live} />;
}

export function Queued({ held, sentFiles }: { held: Held; sentFiles: ReadonlyMap<string, Attachment> }) {
  const styles = useStyles(makeStyles);
  const paths = held.attachments.flatMap((attachment) => (attachment.path ? [attachment.path] : []));
  return (
    <View style={styles.userRow}>
      {paths.length ? (
        <View style={{ opacity: 0.55 }}>
          <SentAttachments paths={paths} sentFiles={sentFiles} />
        </View>
      ) : null}
      {held.text ? (
        <View style={[styles.bubble, { opacity: 0.55 }]}>
          <Text style={styles.userText}>{held.text}</Text>
        </View>
      ) : null}
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
    retry: { color: colors.ink, fontFamily: fonts.uiMedium },
    queuedLabel: { fontFamily: fonts.ui, fontSize: 11, color: colors.inkFaint, marginTop: 4 },
    prose: { fontFamily: fonts.ui, fontSize: 14.5, lineHeight: 23, color: colors.ink },
    thought: { marginVertical: 8 },
    thoughtText: { fontFamily: fonts.uiItalic, fontSize: 12.5, lineHeight: 19.5, color: colors.inkFaint },
    showRest: { alignSelf: 'flex-start', marginTop: 6, marginBottom: 4 },
    showRestText: { fontFamily: fonts.uiMedium, fontSize: 12.5, color: colors.tertiary },
    subagent: { marginVertical: 6 },
    subagentHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      minHeight: 36,
      paddingLeft: 10,
      paddingRight: 11,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: translucent(colors.raised, 0.6),
    },
    chevron: { opacity: 0.7 },
    subagentName: { flexShrink: 0, maxWidth: '45%', fontFamily: fonts.mono, fontSize: 11.5, color: colors.ink },
    subagentTask: { flex: 1, fontFamily: fonts.ui, fontSize: 12, color: colors.inkFaint },
    subagentCalls: { fontFamily: fonts.mono, fontSize: 10.5, color: colors.inkFaint },
    subagentMark: { width: 14, alignItems: 'center' },
    subagentBody: { paddingLeft: 14, paddingTop: 4 },
    empty: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.inkFaint, paddingVertical: 6 },
    notice: {
      alignSelf: 'flex-start',
      maxWidth: '100%',
      gap: 3,
      marginVertical: 5,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: colors.border,
    },
    noticeHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    noticeName: { flexShrink: 1, fontFamily: fonts.mono, fontSize: 11.5, color: colors.ink },
    noticeState: { fontFamily: fonts.ui, fontSize: 12, color: colors.inkFaint },
    noticeSummary: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 17, color: colors.inkFaint },
    earlier: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 10, paddingBottom: 6 },
    earlierText: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.tertiary },
    activity: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 14, marginBottom: 6 },
    activityText: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.inkFaint },
    activityTime: { fontFamily: fonts.mono, fontSize: 10, color: colors.inkFaint },
  });
};
