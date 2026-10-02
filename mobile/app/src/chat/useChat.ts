import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { permissionRequest, promptAction, recordOf, statusFromEvent } from '@mac/chat/acpEvents';
import { chatReducer, initialChatState } from '@mac/chat/reducer';
import type { ChatAction, ChatState } from '@mac/chat/types';
import { MobileError } from '@sikemux/native';

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
  /** Messages rebuilt from the replay, which carries no times. */
  replayed: ReadonlySet<string>;
  attached: 'attaching' | 'live' | 'missing';
  /** Why the chat could not be opened, in the Mac's words. */
  problem: string | null;
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
  const [problem, setProblem] = useState<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const [replayed, setReplayed] = useState<ReadonlySet<string>>(new Set());
  const connection = live.status === 'open' ? live.connection : undefined;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  useEffect(() => {
    if (!connection) return;
    let current = true;
    // The core sends a chat's events in order with the attach answer, and the
    // replay holds everything sent before it, so events ahead of it are dropped.
    let attaching = true;
    apply([{ type: 'reset' }]);
    const off = onEvent(core, (json) => {
      const event = JSON.parse(json) as { kind: string; agentId?: string; event?: CoreChatEvent };
      if (event.kind !== 'chat' || event.agentId !== agentId || !event.event) return;
      if (!attaching) apply(actions(event.event));
    });
    // A chat the Mac put to sleep starts again first; one already running answers at once.
    connection
      .request(JSON.stringify({ op: 'acpWake', agentId }))
      .then(() => connection.request(JSON.stringify({ op: 'acpAttach', agentId })))
      .then((text) => {
        if (!current) return;
        const response = JSON.parse(text) as { kind: string; attachment?: Attachment };
        const attachment = response.attachment;
        if (response.kind !== 'chatAttached' || !attachment || attachment.status !== 'live') {
          setAttached('missing');
          return;
        }
        const replay = attachment.replay.flatMap(actions);
        setReplayed(new Set(reduceAll(initialChatState, replay).messages.map((message) => message.id)));
        apply([
          ...replay,
          { type: 'ready', capabilities: recordOf(attachment.start.capabilities) ?? {}, setup: recordOf(attachment.start.setup) ?? {} },
          ...(attachment.running ? [{ type: 'turn_started' } as const] : []),
        ]);
        attaching = false;
        setAttached('live');
      })
      .catch((error: unknown) => {
        if (!current) return;
        setProblem(MobileError.Refused.instanceOf(error) ? error.inner.message : null);
        setAttached('missing');
      });
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

  return { state, replayed, attached, problem, queued, send, cancel, answer, setConfig };
}
