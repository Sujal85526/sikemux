import { useEffect, useSyncExternalStore } from 'react';

import { onChatEvents, useLive } from '@/devices/hub';
import { ChatSession, type ChatSnapshot } from './session';

/** Every chat this phone opened since it started, so going back to one finds it as it was left. */
const sessions = new Map<string, ChatSession>();

export function chatSession(core: string, agentId: string): ChatSession {
  const key = `${core}:${agentId}`;
  let session = sessions.get(key);
  if (!session) {
    session = new ChatSession(agentId, { listen: (take) => onChatEvents(core, take) });
    sessions.set(key, session);
  }
  return session;
}

/** One chat on one host, attached while this is mounted and the host is connected. */
export function useChat(core: string, agentId: string): { session: ChatSession; chat: ChatSnapshot } {
  const live = useLive(core);
  const session = chatSession(core, agentId);
  const connection = live.status === 'open' ? live.connection : undefined;
  useEffect(() => session.hold(connection), [session, connection]);

  const snapshot = live.snapshot;
  const info = snapshot?.chats.find((chat) => chat.agentId === agentId);
  useEffect(() => {
    if (!snapshot) return;
    const waiting = snapshot.attentions.filter((attention) => attention.agentId === agentId).map((attention) => attention.id);
    session.hostSaw(info, waiting);
  }, [session, snapshot, info, agentId]);

  const chat = useSyncExternalStore(session.subscribe, session.snapshot);
  return { session, chat };
}

export function useDraft(session: ChatSession): string {
  return useSyncExternalStore(session.subscribe, session.draftText);
}
