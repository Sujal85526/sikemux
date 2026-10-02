import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { permissionRequest, promptAction, recordOf, statusFromEvent } from '@mac/chat/acpEvents';
import { chatReducer, initialChatState } from '@mac/chat/reducer';
import type { ChatAction, ChatState } from '@mac/chat/types';
import { onEvent, useLive } from '@/devices/hub';

type CoreChatEvent = { kind: string; payload: Record<string, unknown> };

type Attachment =
  | { status: 'live'; start: { sessionId: string; capabilities: unknown; setup: unknown }; running: boolean; replay: CoreChatEvent[] }
  | { status: 'missing' }
  | { status: 'restart' };

/** The same mapping the Mac's useAcpSession does from a core chat event to the reducer. */
function actions(event: CoreChatEvent): ChatAction[] {
  const payload = event.payload;
  switch (event.kind) {
    case 'status':
      return [{ type: 'status', state: statusFromEvent({ payload } as never) }];
    case 'ready':
      return [{ type: 'ready', capabilities: recordOf(payload.capabilities) ?? {}, setup: recordOf(payload.setup) ?? {} }];
    case 'session_update': {
      const rows = Array.isArray(payload.updates) ? payload.updates : [payload];
      return rows.flatMap((entry): ChatAction[] => {
        const row = recordOf(entry);
        const update = row && recordOf(row.update);
        return update && typeof row.sessionId === 'string'
          ? [{ type: 'session_update', sessionId: row.sessionId, update }]
          : [];
      });
    }
    case 'prompt': {
      const prompted = promptAction(payload);
      return prompted ? [prompted] : [];
    }
    case 'turn_started':
      return [{ type: 'turn_started' }];
    case 'turn_completed':
      return [{ type: 'turn_completed', stopReason: typeof payload.stopReason === 'string' ? payload.stopReason : undefined }];
    case 'permission_request': {
      const request = permissionRequest(payload);
      return request ? [{ type: 'permission_requested', request }] : [];
    }
    case 'error':
      return [{ type: 'error', message: typeof payload.message === 'string' ? payload.message : 'The agent stopped.' }];
    default:
      return [];
  }
}

function reduceAll(state: ChatState, batch: ChatAction[]): ChatState {
  return batch.reduce(chatReducer, state);
}

export type ChatView = {
  state: ChatState;
  attached: 'attaching' | 'live' | 'missing';
  queued: string | null;
  send: (text: string) => void;
  cancel: () => void;
  answer: (requestId: string, optionId: string | null) => void;
  setConfig: (configId: string, value: string) => void;
};

export function useChat(core: string, agentId: string): ChatView {
  const live = useLive(core);
  const [state, apply] = useReducer(reduceAll, initialChatState);
  const [attached, setAttached] = useState<ChatView['attached']>('attaching');
  const [queued, setQueued] = useState<string | null>(null);
  const connection = live.status === 'open' ? live.connection : undefined;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  useEffect(() => {
    if (!connection) return;
    let current = true;
    let early: CoreChatEvent[] | null = [];
    apply([{ type: 'reset' }]);
    const off = onEvent(core, (json) => {
      const event = JSON.parse(json) as { kind: string; agentId?: string; event?: CoreChatEvent };
      if (event.kind !== 'chat' || event.agentId !== agentId || !event.event) return;
      if (early) early.push(event.event);
      else apply(actions(event.event));
    });
    connection
      .request(JSON.stringify({ op: 'acpAttach', agentId }))
      .then((text) => {
        if (!current) return;
        const response = JSON.parse(text) as { kind: string; attachment?: Attachment };
        const attachment = response.attachment;
        if (response.kind !== 'chatAttached' || !attachment || attachment.status !== 'live') {
          setAttached('missing');
          return;
        }
        const replay = attachment.replay.flatMap(actions);
        apply([
          ...replay,
          { type: 'ready', capabilities: recordOf(attachment.start.capabilities) ?? {}, setup: recordOf(attachment.start.setup) ?? {} },
          ...(attachment.running ? [{ type: 'turn_started' } as const] : []),
          ...(early ?? []).flatMap(actions),
        ]);
        early = null;
        setAttached('live');
      })
      .catch(() => current && setAttached('missing'));
    return () => {
      current = false;
      off();
    };
  }, [connection, core, agentId]);

  const request = useCallback((body: Record<string, unknown>) => {
    const open = connectionRef.current;
    if (!open) return Promise.reject(new Error('Not connected'));
    return open.request(JSON.stringify(body)).then((text) => JSON.parse(text) as Record<string, unknown>);
  }, []);

  const prompt = useCallback(
    (text: string) => {
      apply([{ type: 'local_prompt', text, paths: [] }]);
      request({ op: 'acpPrompt', agentId, text, paths: [], context: [] }).catch((error: unknown) =>
        apply([{ type: 'error', message: String(error) }]),
      );
    },
    [agentId, request],
  );

  const running = state.running;
  useEffect(() => {
    if (running || queued === null) return;
    setQueued(null);
    prompt(queued);
  }, [running, queued, prompt]);

  const send = useCallback(
    (text: string) => {
      if (running) setQueued((held) => (held ? `${held}\n\n${text}` : text));
      else prompt(text);
    },
    [running, prompt],
  );

  const cancel = useCallback(() => {
    request({ op: 'acpCancel', agentId }).catch(() => {});
  }, [agentId, request]);

  const answer = useCallback(
    (requestId: string, optionId: string | null) => {
      apply([{ type: 'permission_cleared', requestId }]);
      request({ op: 'acpPermissionReply', agentId, requestId, optionId }).catch((error: unknown) =>
        apply([{ type: 'error', message: String(error) }]),
      );
    },
    [agentId, request],
  );

  const setConfig = useCallback(
    (configId: string, value: string) => {
      request({ op: 'acpSetConfig', agentId, configId, value })
        .then((response) => {
          const options = recordOf(response.value)?.configOptions;
          if (options) apply([{ type: 'config', options }]);
        })
        .catch((error: unknown) => apply([{ type: 'error', message: String(error) }]));
    },
    [agentId, request],
  );

  return { state, attached, queued, send, cancel, answer, setConfig };
}
