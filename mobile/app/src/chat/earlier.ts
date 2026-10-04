import { chatReducer, initialChatState } from '@mac/chat/reducer';
import type { ChatAction, ChatMessage, ChatState } from '@mac/chat/types';

/** How many turns one trip back through a long chat brings from the host. */
export const PAGE_TURNS = 20;

/**
 * Turns from before what the phone holds, drawn on their own. Each page is whole turns, so
 * nothing in it continues something later. The ids are renamed so an earlier message can never
 * take the id of one already on screen, which the list keeps its place by.
 */
export function earlierMessages(actions: ChatAction[], page: number): ChatMessage[] {
  return actions.reduce(chatReducer, initialChatState).messages.map((message) => ({ ...message, id: `earlier-${page}-${message.id}` }));
}

export function withEarlier(state: ChatState, messages: ChatMessage[]): ChatState {
  return messages.length ? { ...state, messages: [...messages, ...state.messages], revision: state.revision + 1 } : state;
}
