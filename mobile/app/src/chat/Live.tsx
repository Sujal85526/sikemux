import { Fragment, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { subagentActivity, taskDetail } from '@mac/chat/transcript';
import { AgentIcon, Icon } from '@/ui/Icon';
import { SectionLabel } from '@/ui/list';
import { Sheet } from '@/ui/Sheet';
import { Dot, Working } from '@/ui/status';
import { fonts, type Palette, useColors, useStyles } from '@/ui/theme';
import type { LiveWork, PlanEntry } from './liveWork';

/** A kind of work named the way the Mac's live stack names it, counted. */
function counted(word: string, count: number): string {
  return count === 1 || word === 'queued' ? word : `${word}s`;
}

function TaskIcon({ kind, color, size = 12 }: { kind: string; color: string; size?: number }) {
  return <Icon name={kind === 'shell' ? 'IconCommand' : 'IconTimer'} size={size} color={color} />;
}

/** Past this many kinds the strip drops the words and keeps the counts. */
const WORDED = 3;

/**
 * One line docked on the composer saying what is still going: subagents, background tasks by
 * kind, waiting messages and the plan's progress. A tap opens all of it.
 */
export function LiveStrip({ work, provider, onOpen }: { work: LiveWork; provider: string; onOpen: () => void }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const done = work.plan.filter((entry) => entry.status === 'completed').length;
  const pieces: { key: string; icon: ReactNode; count: string; word: string }[] = [
    ...(work.subagents.length
      ? [
          {
            key: 'subagents',
            icon: <AgentIcon provider={provider} size={12} />,
            count: String(work.subagents.length),
            word: counted('subagent', work.subagents.length),
          },
        ]
      : []),
    ...work.tasks.map(([kind, tasks]) => ({
      key: `task-${kind}`,
      icon: <TaskIcon kind={kind} color={colors.inkDim} />,
      count: String(tasks.length),
      word: counted(kind, tasks.length),
    })),
    ...(work.queued.length
      ? [
          {
            key: 'queued',
            icon: <Icon name="IconClock" size={12} color={colors.inkDim} />,
            count: String(work.queued.length),
            word: 'queued',
          },
        ]
      : []),
    ...(work.planOpen
      ? [
          {
            key: 'plan',
            icon: <Icon name="IconCheck" size={12} color={colors.inkDim} />,
            count: `${done}/${work.plan.length}`,
            word: 'plan',
          },
        ]
      : []),
  ];
  const worded = pieces.length <= WORDED;
  const working = work.subagents.length > 0 || work.tasks.some(([, tasks]) => tasks.some((task) => task.state === 'running'));
  return (
    <Pressable
      onPress={onOpen}
      style={({ pressed }) => [styles.strip, pressed && { backgroundColor: colors.raised }]}
      accessibilityRole="button"
      accessibilityLabel={`${pieces.map((piece) => `${piece.count} ${piece.word}`).join(', ')}. Show`}>
      {working ? <Working /> : null}
      <View style={styles.pieces}>
        {pieces.map((piece) => (
          <View key={piece.key} style={styles.piece}>
            {piece.icon}
            <Text style={styles.pieceText} numberOfLines={1}>
              {piece.key === 'plan' && worded ? `${piece.word} ` : null}
              <Text style={styles.count}>{piece.count}</Text>
              {piece.key !== 'plan' && worded ? ` ${piece.word}` : null}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.up}>
        <Icon name="IconChevron" size={10} color={colors.inkFaint} />
      </View>
    </Pressable>
  );
}

function SmallButton({
  label,
  onPress,
  busy,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  accessibilityLabel: string;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      hitSlop={6}
      style={({ pressed }) => [styles.small, pressed && { backgroundColor: colors.active }]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy, disabled: busy }}>
      {busy ? <ActivityIndicator size="small" color={colors.inkDim} /> : <Text style={styles.smallText}>{label}</Text>}
    </Pressable>
  );
}

function Line({ mark, title, detail, end, faint }: { mark: ReactNode; title: string; detail?: string; end?: ReactNode; faint?: boolean }) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.line}>
      <View style={styles.mark}>{mark}</View>
      <View style={styles.lineBody}>
        <Text style={[styles.lineTitle, faint && { color: colors.tertiary }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={styles.lineDetail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {end ? <View style={styles.lineEnd}>{end}</View> : null}
    </View>
  );
}

function PlanMark({ status }: { status: PlanEntry['status'] }) {
  const colors = useColors();
  if (status === 'completed') return <Icon name="IconCheck" size={14} color={colors.inkDim} />;
  if (status === 'in_progress') return <Working />;
  return <Dot color={colors.rest} size={8} hollow />;
}

/** Everything the strip sums up, in the Mac's live stack's order, with what can be done about each. */
export function LiveSheet({
  visible,
  onClose,
  work,
  provider,
  steerable,
  canAct,
  stopping,
  onStopTask,
  onSteer,
  onDrop,
}: {
  visible: boolean;
  onClose: () => void;
  work: LiveWork;
  provider: string;
  /** The agent takes a message mid-turn, and a turn is running. */
  steerable: boolean;
  /** This phone may act on the chat rather than only watch it. */
  canAct: boolean;
  stopping: ReadonlySet<string>;
  onStopTask: (taskId: string) => void;
  onSteer: (ids: string[]) => void;
  onDrop: (id: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const done = work.plan.filter((entry) => entry.status === 'completed').length;
  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={styles.sheet}>
        {work.subagents.length ? (
          <>
            <SectionLabel count={work.subagents.length}>{counted('subagent', work.subagents.length)}</SectionLabel>
            {work.subagents.map((subagent) => (
              <Line
                key={subagent.sessionId}
                mark={<AgentIcon provider={provider} size={16} />}
                title={subagent.name}
                detail={subagentActivity(subagent)}
                end={<Working />}
              />
            ))}
          </>
        ) : null}
        {work.tasks.map(([kind, tasks]) => (
          <Fragment key={kind}>
            <SectionLabel count={tasks.length}>{counted(kind, tasks.length)}</SectionLabel>
            {tasks.map((task) => (
              <Line
                key={task.asyncTaskId}
                mark={<TaskIcon kind={kind} size={15} color={task.state === 'paused' ? colors.warn : colors.inkDim} />}
                title={task.name}
                detail={task.state === 'paused' ? 'paused' : taskDetail(task)}
                end={
                  canAct && task.canStop ? (
                    <SmallButton
                      label="Stop"
                      busy={stopping.has(task.asyncTaskId)}
                      onPress={() => onStopTask(task.asyncTaskId)}
                      accessibilityLabel={`Stop ${task.name}`}
                    />
                  ) : null
                }
              />
            ))}
          </Fragment>
        ))}
        {work.queued.length ? (
          <>
            <SectionLabel
              count={work.queued.length}
              action={
                steerable && work.queued.length > 1 ? (
                  <SmallButton
                    label="Steer all"
                    onPress={() => onSteer(work.queued.map((held) => held.id))}
                    accessibilityLabel="Steer the running turn with every queued message"
                  />
                ) : null
              }>
              queued
            </SectionLabel>
            {work.queued.map((held) => {
              const files = held.attachments.length;
              const label = held.text || held.attachments.map((attachment) => attachment.name).join(', ');
              return (
                <Line
                  key={held.id}
                  mark={<Icon name="IconClock" size={15} color={colors.inkDim} />}
                  title={label}
                  detail={held.text && files ? `${files} ${files === 1 ? 'file' : 'files'}` : undefined}
                  end={
                    <>
                      {steerable ? (
                        <SmallButton
                          label="Steer"
                          onPress={() => onSteer([held.id])}
                          accessibilityLabel={`Steer the running turn with ${label}`}
                        />
                      ) : null}
                      <Pressable
                        onPress={() => onDrop(held.id)}
                        hitSlop={8}
                        style={({ pressed }) => [styles.drop, pressed && { backgroundColor: colors.active }]}
                        accessibilityRole="button"
                        accessibilityLabel={`Drop ${label} from the queue`}>
                        <Icon name="IconClose" size={11} color={colors.inkDim} />
                      </Pressable>
                    </>
                  }
                />
              );
            })}
          </>
        ) : null}
        {work.plan.length ? (
          <>
            <SectionLabel action={<Text style={styles.progress}>{`${done} of ${work.plan.length}`}</Text>}>plan</SectionLabel>
            {work.plan.map((entry, index) => (
              <View key={index} style={styles.step}>
                <View style={styles.stepMark}>
                  <PlanMark status={entry.status} />
                </View>
                <Text
                  style={[
                    styles.stepText,
                    entry.status === 'completed' && { color: colors.tertiary },
                    entry.status === 'in_progress' && { color: colors.ink },
                  ]}>
                  {entry.content}
                </Text>
              </View>
            ))}
          </>
        ) : null}
      </View>
    </Sheet>
  );
}

const makeStyles = (colors: Palette) => {
  return StyleSheet.create({
    strip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      height: 34,
      marginHorizontal: 14,
      marginBottom: -1,
      paddingLeft: 12,
      paddingRight: 10,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: colors.border,
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      backgroundColor: colors.composer,
    },
    pieces: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden' },
    piece: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
    pieceText: { fontFamily: fonts.ui, fontSize: 12, color: colors.tertiary },
    count: { fontFamily: fonts.uiMedium, color: colors.ink, fontVariant: ['tabular-nums'] },
    up: { transform: [{ rotate: '-90deg' }] },
    sheet: { paddingBottom: 8 },
    line: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 8, paddingVertical: 6 },
    mark: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
    lineBody: { flex: 1, minWidth: 0 },
    lineTitle: { fontFamily: fonts.uiMedium, fontSize: 14.5, letterSpacing: -0.15, color: colors.secondary },
    lineDetail: { fontFamily: fonts.ui, fontSize: 12, color: colors.tertiary, marginTop: 1 },
    lineEnd: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    small: {
      minWidth: 52,
      height: 28,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    smallText: { fontFamily: fonts.uiMedium, fontSize: 12.5, color: colors.ink },
    drop: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    progress: { fontFamily: fonts.ui, fontSize: 11, color: colors.inkDim, fontVariant: ['tabular-nums'] },
    step: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 8, paddingVertical: 7 },
    stepMark: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
    stepText: { flex: 1, fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: colors.secondary },
  });
};
