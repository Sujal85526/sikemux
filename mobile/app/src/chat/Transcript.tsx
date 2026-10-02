import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { durationLabel } from '@mac/chat/durationLabel';
import { toolKind, toolRunning, toolTarget } from '@mac/chat/toolLabels';
import type { ChatMessage, ChatPart } from '@mac/chat/types';
import { AgentIcon, Icon } from '@/ui/Icon';
import type { IconName } from '@/ui/icons.generated';
import { colors, fonts } from '@/ui/theme';
import { Markdown } from './Markdown';

type ToolPart = Extract<ChatPart, { kind: 'tool' }>;

/** The verb, icon and colour of each kind of call, as the Mac's tool rows draw them. */
function look(kind: string): { icon: IconName; color: string } {
  switch (kind) {
    case 'run':
      return { icon: 'IconCommand', color: '#d966ae' };
    case 'read':
      return { icon: 'IconFile', color: '#7183c0' };
    case 'search':
      return { icon: 'IconSearch', color: '#7183c0' };
    case 'fetch':
      return { icon: 'IconGlobe', color: '#7183c0' };
    case 'edit':
    case 'move':
      return { icon: 'IconPencil', color: '#cdaf86' };
    case 'delete':
      return { icon: 'IconPencil', color: '#c25e4b' };
    default:
      return { icon: 'IconAgent', color: colors.inkDim };
  }
}

function ToolRow({ part, last }: { part: ToolPart; last: boolean }) {
  const kind = toolKind(part.tool);
  const { icon, color } = look(kind);
  const failed = part.tool.status === 'failed';
  const running = toolRunning(part.tool);
  const spent = part.startedAt && part.endedAt && part.endedAt > part.startedAt ? durationLabel(part.endedAt - part.startedAt) : null;
  return (
    <View style={styles.tool}>
      <View style={[styles.spine, last && styles.spineLast]} />
      <View style={[styles.tick, last && styles.elbow]} />
      <Icon name={failed ? 'IconWarning' : icon} size={12} color={failed ? colors.danger : color} />
      <Text style={[styles.kind, { color: failed ? colors.danger : color }]}>{kind}</Text>
      <Text style={[styles.target, running && { color: colors.inkDim }]} numberOfLines={1}>
        {toolTarget(part.tool)}
      </Text>
      <View style={styles.toolEnd}>
        {part.diff ? (
          <Text style={styles.endText}>
            <Text style={{ color: colors.gitAdded }}>+{part.diff.adds}</Text> <Text style={{ color: colors.gitDeleted }}>−{part.diff.dels}</Text>
          </Text>
        ) : null}
        {!part.diff && spent ? <Text style={styles.endText}>{spent}</Text> : null}
      </View>
    </View>
  );
}

function ToolGroup({ parts }: { parts: ToolPart[] }) {
  const working = parts.some((part) => toolRunning(part.tool));
  const [open, setOpen] = useState(working);
  useEffect(() => {
    if (working) setOpen(true);
  }, [working]);
  const started = parts[0]?.startedAt;
  const ended = parts[parts.length - 1]?.endedAt;
  return (
    <View style={styles.tools}>
      <Pressable onPress={() => setOpen(!open)} style={styles.summary} hitSlop={6} accessibilityRole="button">
        <Text style={styles.summaryText}>
          {parts.length} tool call{parts.length === 1 ? '' : 's'}
        </Text>
        {started && ended && ended > started ? <Text style={styles.summaryTime}>{durationLabel(ended - started)}</Text> : null}
        <View style={[styles.summaryChevron, open && { transform: [{ rotate: '90deg' }] }]}>
          <Icon name="IconChevron" size={11} color={colors.inkDim} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.toolsBody}>
          {parts.map((part, index) => (
            <ToolRow key={part.id} part={part} last={index === parts.length - 1} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function userText(message: ChatMessage): string {
  return message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n');
}

function Assistant({ message }: { message: ChatMessage }) {
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
        if (Array.isArray(run)) return <ToolGroup key={run[0].id} parts={run} />;
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
          default:
            return <View key={index} />;
        }
      })}
    </>
  );
}

export function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={styles.bubble}>
          <Markdown text={userText(message)} style={styles.userText} />
        </View>
      </View>
    );
  }
  return <Assistant message={message} />;
}

export function Queued({ text }: { text: string }) {
  return (
    <View style={styles.userRow}>
      <View style={[styles.bubble, { opacity: 0.55 }]}>
        <Text style={styles.userText}>{text}</Text>
      </View>
      <Text style={styles.queuedLabel}>Sends when this turn ends</Text>
    </View>
  );
}

/** The working line: the agent's logo breathing beside what it is doing, and for how long. */
export function Activity({ provider, label, since }: { provider: string; label: string; since: number }) {
  const breath = useRef(new Animated.Value(1)).current;
  const [seconds, setSeconds] = useState(0);
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
    <View style={styles.activity}>
      <Animated.View style={{ opacity: breath }}>
        <AgentIcon provider={provider} size={20} />
      </Animated.View>
      <Text style={styles.activityText}>{label}</Text>
      {seconds > 0 ? <Text style={styles.activityTime}>{durationLabel(seconds * 1000)}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: { alignItems: 'flex-end', marginTop: 14, marginBottom: 6 },
  bubble: {
    maxWidth: '84%',
    paddingVertical: 9,
    paddingHorizontal: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(36, 36, 43, 0.8)',
    backgroundColor: 'rgba(25, 25, 30, 0.72)',
  },
  userText: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 24, color: colors.ink },
  queuedLabel: { fontFamily: fonts.ui, fontSize: 11.5, color: colors.inkFaint, marginTop: 4 },
  prose: { fontFamily: fonts.ui, fontSize: 15.5, lineHeight: 25, color: colors.ink },
  thought: { fontFamily: fonts.uiItalic, fontSize: 13.5, lineHeight: 21, color: colors.inkFaint, marginVertical: 8 },
  note: { fontFamily: fonts.ui, fontSize: 13, color: colors.inkDim, marginVertical: 6 },
  tools: { marginVertical: 6 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 26, alignSelf: 'flex-start' },
  summaryText: { fontFamily: fonts.ui, fontSize: 13, color: colors.inkDim },
  summaryTime: { fontFamily: fonts.mono, fontSize: 11.5, color: colors.inkDim },
  summaryChevron: { opacity: 0.7 },
  toolsBody: { marginLeft: 6, paddingVertical: 2 },
  tool: { flexDirection: 'row', alignItems: 'center', minHeight: 26, gap: 8 },
  spine: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 1, backgroundColor: '#5f4a8a' },
  spineLast: { bottom: '50%' },
  tick: { width: 10, height: 1, backgroundColor: 'rgba(162, 119, 255, 0.72)' },
  elbow: {
    height: 9,
    marginTop: -9,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
    borderBottomLeftRadius: 4,
    borderColor: 'rgba(162, 119, 255, 0.72)',
    backgroundColor: 'transparent',
  },
  kind: { fontFamily: fonts.mono, fontSize: 12 },
  target: { flex: 1, fontFamily: fonts.mono, fontSize: 12, color: colors.ink },
  toolEnd: { flexDirection: 'row', gap: 6 },
  endText: { fontFamily: fonts.mono, fontSize: 11, color: colors.inkDim },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 14, marginBottom: 6 },
  activityText: { fontFamily: fonts.ui, fontSize: 13, color: colors.inkFaint },
  activityTime: { fontFamily: fonts.mono, fontSize: 10.5, color: 'rgba(115, 111, 128, 0.68)' },
});
