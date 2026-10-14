import { memo, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { ConnectionLike } from '@sikemux/native';

import type { AgentQuestion, QuestionAnswer } from '@mac/agents/agentQuestions';
import { agentLabel } from '@mac/agents/catalog';
import { formatAge, formatDuration } from '@mac/lib/format';
import type { Attention, Digest, InboxItem, InboxTier } from '@/core/protocol';
import { haptics } from '@/ui/haptics';
import { AgentIcon, Icon } from '@/ui/Icon';
import { Chip, IconButton } from '@/ui/controls';
import { Row, Rows, SectionLabel } from '@/ui/list';
import { Dot, NeedsYou, Working } from '@/ui/status';
import { fonts, type Palette, radius, typeFor, useColors, useStyles } from '@/ui/theme';
import { problem as problemOf } from './hub';
import { useHostQuestions } from './questions';

type Tab = 'terminals' | 'board';

/** What a row's buttons ask for. */
type Act = { item: InboxItem; allow: boolean } | { item: InboxItem; given: QuestionAnswer };

const DIGEST_SHOWN = 4;

const TIER_LABELS: Record<InboxTier, string> = {
  needs: 'Needs you',
  review: 'To review',
  finished: 'Finished',
  progress: 'Working',
};

/** The items in runs of one tier, keeping the core's order. */
function byTier(items: readonly InboxItem[]): { tier: InboxTier; items: InboxItem[] }[] {
  const runs: { tier: InboxTier; items: InboxItem[] }[] = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (last?.tier === item.tier) last.items.push(item);
    else runs.push({ tier: item.tier, items: [item] });
  }
  return runs;
}

function itemTitle(item: InboxItem): string {
  return item.title ?? item.card?.title ?? agentLabel(item.cli ?? 'agent');
}

/** Opens what an item is about: its pull request, its chat, or the tab that lists its terminal or card. */
function opener(core: string, onTab: (tab: Tab) => void) {
  return (item: InboxItem) => {
    if (item.kind === 'pullRequest' && item.url) void Linking.openURL(item.url);
    else if (item.feed && item.agentId) router.push(`/device/${core}/chat/${item.agentId}`);
    else if (item.session !== undefined) onTab('terminals');
    else if (item.card) onTab('board');
  };
}

function ItemEnd({ item }: { item: InboxItem }) {
  const colors = useColors();
  if (item.tier === 'needs') return <NeedsYou />;
  if (item.tier === 'progress') return <Working />;
  return <Dot color={item.kind === 'failed' ? colors.danger : colors.accent} />;
}

/** What the agent left: its last words, what it changed and what it recorded. */
function HandoffLines({ item }: { item: InboxItem }) {
  const styles = useStyles(makeStyles);
  const { handoff, recordings } = item;
  const said = handoff?.result ?? handoff?.answer;
  const edited = handoff?.edited ?? 0;
  const facts = [
    edited ? `${edited} file${edited === 1 ? '' : 's'} changed` : null,
    recordings.length
      ? `${recordings.length === 1 ? 'Recording' : `${recordings.length} recordings`} · ${formatDuration(recordings.reduce((sum, rec) => sum + rec.seconds, 0) * 1000)}`
      : null,
  ].filter(Boolean);
  if (!said && !facts.length) return null;
  return (
    <>
      {said ? (
        <Text style={styles.prose} numberOfLines={2}>
          {said}
        </Text>
      ) : null}
      {facts.length ? <Text style={styles.facts}>{facts.join(' · ')}</Text> : null}
    </>
  );
}

const InboxRow = memo(function InboxRow({
  item,
  place,
  attention,
  question,
  full,
  busy,
  onOpen,
  onAct,
}: {
  item: InboxItem;
  place?: string;
  attention?: Attention;
  question?: AgentQuestion;
  /** The phone may drive the host, not only watch it and answer permissions. */
  full: boolean;
  busy: boolean;
  onOpen: (item: InboxItem) => void;
  onAct: (act: Act) => void;
}) {
  const styles = useStyles(makeStyles);
  const permission = item.kind === 'permission';
  const shownDetail = item.detail && !permission ? item.detail : undefined;
  return (
    <View>
      <Row
        mark={item.cli ? <AgentIcon provider={item.cli} size={20} /> : <Icon name="IconBoard" size={17} />}
        name={item.name}
        title={itemTitle(item)}
        place={place}
        detail={item.what}
        end={<ItemEnd item={item} />}
        onPress={() => onOpen(item)}
      />
      <View style={styles.below}>
        {permission && item.detail ? (
          <Text style={styles.command} numberOfLines={2}>
            {item.detail}
          </Text>
        ) : null}
        {shownDetail ? (
          <Text style={styles.prose} numberOfLines={3}>
            {shownDetail}
          </Text>
        ) : null}
        {item.tier === 'review' || item.tier === 'finished' ? <HandoffLines item={item} /> : null}
        {permission && attention ? (
          <View style={styles.chips}>
            <Chip title="Deny" busy={busy} onPress={() => onAct({ item, allow: false })} />
            <Chip title="Allow" primary busy={busy} onPress={() => onAct({ item, allow: true })} />
          </View>
        ) : null}
        {item.kind === 'question' && question && full ? (
          <View style={styles.chips}>
            {question.choices.map((choice, index) => (
              <Chip key={index} title={choice.label} busy={busy} onPress={() => onAct({ item, given: { choice: index } })} />
            ))}
            <Chip title="Reply…" onPress={() => onOpen(item)} />
          </View>
        ) : null}
        {item.kind === 'assumption' && full ? (
          <View style={styles.chips}>
            <Chip title="Fine" busy={busy} onPress={() => onAct({ item, given: { fine: true } })} />
            <Chip title="Change" onPress={() => onOpen(item)} />
          </View>
        ) : null}
      </View>
    </View>
  );
});

/** What finished and failed while the person was away, until they put it away. */
function AwayDigest({
  digest,
  minute,
  onOpen,
  onDismiss,
}: {
  digest: Digest;
  minute: number;
  onOpen: (item: InboxItem) => void;
  onDismiss: () => void;
}) {
  const styles = useStyles(makeStyles);
  const items = [...digest.failed, ...digest.finished];
  const counts = [
    digest.finished.length ? `${digest.finished.length} finished` : null,
    digest.failed.length ? `${digest.failed.length} failed` : null,
    digest.waiting.length ? `${digest.waiting.length} wait${digest.waiting.length === 1 ? 's' : ''} on you` : null,
  ].filter(Boolean);
  return (
    <View style={styles.digest} accessibilityLiveRegion="polite">
      <View style={styles.digestHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.digestTitle}>
            While you were away
            {digest.since ? <Text style={styles.digestSince}> · {formatAge(digest.since, minute * 60_000)}</Text> : null}
          </Text>
          <Text style={styles.facts}>{counts.join(' · ')}</Text>
        </View>
        <IconButton name="IconClose" label="Put the digest away" onPress={onDismiss} />
      </View>
      <Rows>
        {items.slice(0, DIGEST_SHOWN).map((item) => (
          <Row
            key={item.id}
            mark={item.cli ? <AgentIcon provider={item.cli} size={20} /> : <Icon name="IconBoard" size={17} />}
            name={item.name}
            title={itemTitle(item)}
            detail={item.detail ?? item.handoff?.result ?? item.handoff?.answer ?? item.what}
            end={<ItemEnd item={item} />}
            onPress={() => onOpen(item)}
          />
        ))}
      </Rows>
      {items.length > DIGEST_SHOWN ? <Text style={[styles.facts, styles.more]}>{items.length - DIGEST_SHOWN} more</Text> : null}
    </View>
  );
}

/**
 * The host's inbox as its core ranks it: what waits on the person, then changes to review, finished work and work
 * under way. Permissions, questions and assumptions are answered on their row.
 */
export function Inbox({
  core,
  connection,
  items,
  working,
  attentions,
  full,
  placeOf,
  digest,
  minute,
  onDismissDigest,
  onTab,
}: {
  core: string;
  connection?: ConnectionLike;
  items: readonly InboxItem[];
  working: number;
  attentions: readonly Attention[];
  full: boolean;
  placeOf: (item: InboxItem) => string | undefined;
  digest?: Digest;
  minute: number;
  onDismissDigest: () => void;
  onTab: (tab: Tab) => void;
}) {
  const styles = useStyles(makeStyles);
  const asked = items.filter((item) => item.questionId);
  const questions = useHostQuestions(asked.length ? connection : undefined, asked.map((item) => item.id).join(' '));
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [note, setNote] = useState<string>();
  const open = opener(core, onTab);

  const act = async (act: Act) => {
    if (!connection || busy.has(act.item.id)) return;
    setBusy((current) => new Set(current).add(act.item.id));
    setNote(undefined);
    try {
      if ('allow' in act) {
        const choices = attentions.find((attention) => attention.id === act.item.requestId)?.choices;
        const option = act.allow ? (choices?.allowOnce ?? choices?.allowAlways) : choices?.reject;
        await connection.answerPermission(act.item.agentId ?? '', act.item.requestId ?? '', option);
      } else {
        await connection.call('answerQuestion', JSON.stringify({ id: act.item.questionId, ...act.given }));
      }
      haptics.success();
    } catch (error) {
      haptics.failure();
      setNote(problemOf(error));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(act.item.id);
        return next;
      });
    }
  };

  // Rows redraw only when their own item does, so they call the latest handlers through refs.
  const latest = useRef({ open, act });
  useEffect(() => {
    latest.current = { open, act };
  });
  const onOpen = (item: InboxItem) => latest.current.open(item);
  const onAct = (given: Act) => void latest.current.act(given);

  return (
    <>
      {digest ? <AwayDigest digest={digest} minute={minute} onOpen={onOpen} onDismiss={onDismissDigest} /> : null}
      {byTier(items).map(({ tier, items: run }) => (
        <View key={tier}>
          <SectionLabel count={tier === 'progress' ? working : undefined}>{TIER_LABELS[tier]}</SectionLabel>
          <Rows>
            {run.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                place={placeOf(item)}
                attention={item.requestId ? attentions.find((attention) => attention.id === item.requestId) : undefined}
                question={item.questionId ? questions.find((question) => question.id === item.questionId) : undefined}
                full={full}
                busy={busy.has(item.id)}
                onOpen={onOpen}
                onAct={onAct}
              />
            ))}
          </Rows>
        </View>
      ))}
      {note ? (
        <Text style={styles.note} accessibilityLiveRegion="polite">
          {note}
        </Text>
      ) : null}
    </>
  );
}

/** Lines under a row start where its text does: past the row's inset, its mark and the gap after it. */
const TEXT_INSET = 38;

const makeStyles = (colors: Palette) => {
  const type = typeFor(colors);
  return StyleSheet.create({
    below: { paddingLeft: TEXT_INSET, paddingRight: 8, gap: 6 },
    command: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, color: colors.secondary },
    prose: { ...type.meta, fontSize: 13, lineHeight: 18, color: colors.inkDim },
    facts: { ...type.meta, fontSize: 12 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 2, paddingBottom: 6 },
    digest: {
      marginTop: 12,
      paddingTop: 10,
      paddingBottom: 6,
      paddingHorizontal: 4,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.raised,
    },
    digestHead: { flexDirection: 'row', alignItems: 'center', paddingLeft: 8, paddingBottom: 4 },
    digestTitle: { fontFamily: fonts.uiSemibold, fontSize: 15, letterSpacing: -0.2, color: colors.ink },
    digestSince: { fontFamily: fonts.ui, color: colors.tertiary },
    more: { paddingLeft: TEXT_INSET + 4, paddingVertical: 6 },
    note: { ...type.meta, fontSize: 12.5, color: colors.danger, paddingHorizontal: 8, paddingTop: 8 },
  });
};
