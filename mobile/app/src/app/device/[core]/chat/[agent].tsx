import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { activityText, composerPlaceholder } from '@mac/chat/chatStatus';
import { activeToolLabel } from '@mac/chat/toolLabels';
import { Composer } from '@/chat/Composer';
import { Activity, Message, Queued } from '@/chat/Transcript';
import { useChat } from '@/chat/useChat';
import { useDevices, useLive } from '@/devices/hub';
import { chatTitle, providerName } from '@/devices/words';
import { AgentIcon } from '@/ui/Icon';
import { Nav, Screen, Working } from '@/ui/parts';
import { colors, fonts, type } from '@/ui/theme';

/** When the running turn began, as this phone saw it, for the working line's clock. */
function useTurnStart(running: boolean): number {
  const [since, setSince] = useState(Date.now());
  const was = useRef(running);
  useEffect(() => {
    if (running && !was.current) setSince(Date.now());
    was.current = running;
  }, [running]);
  return since;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1) + (text.endsWith('.') ? '' : '.');
}

export default function Chat() {
  const { core, agent } = useLocalSearchParams<{ core: string; agent: string }>();
  const live = useLive(core);
  const { devices } = useDevices();
  const access = devices.find((device) => device.core === core)?.access ?? 'full';
  const info = live.snapshot?.chats.find((chat) => chat.agentId === agent);
  const provider = info?.provider ?? 'agent';
  const chat = useChat(core, agent);
  const { state } = chat;
  const since = useTurnStart(state.running);
  const scroller = useRef<ScrollView>(null);
  // The composer arrives once the chat attaches and shortens the transcript, so its layout scrolls too.
  const toEnd = () => requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: false }));
  const activity = activityText(state, activeToolLabel(state.messages));
  const title = state.title ?? (info ? chatTitle(info) : providerName(provider));

  return (
    <Screen>
      <Nav
        title={
          <>
            <AgentIcon provider={provider} size={17} />
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          </>
        }
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView
          ref={scroller}
          style={styles.transcript}
          contentContainerStyle={styles.content}
          onContentSizeChange={toEnd}
          onLayout={toEnd}
          keyboardDismissMode="interactive">
          {chat.attached === 'missing' ? (
            <Text style={styles.gone}>{chat.problem ? capitalised(chat.problem) : 'This chat is no longer running on the Mac.'}</Text>
          ) : chat.attached === 'attaching' ? (
            <View style={styles.attaching}>
              <Working />
              <Text style={type.meta}>{info?.asleep ? 'Waking the chat…' : 'Opening the chat…'}</Text>
            </View>
          ) : null}
          {state.messages.map((message) => (
            <Message key={message.id} message={message} untimed={chat.replayed.has(message.id)} />
          ))}
          {chat.queued ? <Queued text={chat.queued} /> : null}
          {activity ? <Activity provider={provider} label={activity} since={since} /> : null}
          {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
        </ScrollView>
        {chat.attached === 'live' ? (
          <Composer
            state={state}
            provider={provider}
            placeholder={composerPlaceholder(state, { resuming: false, disconnected: live.status !== 'open' })}
            permissionMode={info?.permissionMode ?? ''}
            watchOnly={access === 'watch'}
            onSend={chat.send}
            onStop={chat.cancel}
            onAnswer={chat.answer}
            onConfig={chat.setConfig}
          />
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.uiSemibold, fontSize: 16, letterSpacing: -0.25, color: colors.ink, flexShrink: 1 },
  transcript: { flex: 1, borderTopWidth: 1, borderTopColor: colors.border },
  content: { paddingHorizontal: 18, paddingTop: 6, paddingBottom: 12, flexGrow: 1, justifyContent: 'flex-end' },
  attaching: { flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'center', paddingVertical: 24 },
  gone: { ...type.meta, textAlign: 'center', paddingVertical: 24 },
  error: { fontFamily: fonts.ui, fontSize: 13.5, color: colors.danger, marginTop: 10 },
});
