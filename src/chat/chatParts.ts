import { lazyPart, loadParts } from "../lib/lazyPart";

export const QuestionRows = lazyPart(() => import("./QuestionRows").then((module) => module.default));
export const LiveStack = lazyPart(() => import("./LiveStack").then((module) => module.default));
export const ChatFailureActions = lazyPart(() => import("./ChatFailureActions").then((module) => module.ChatFailureActions));
export const ComposerMenu = lazyPart(() => import("./ComposerMenu").then((module) => module.default));
export const DictationPreview = lazyPart(() => import("./DictationPreview").then((module) => module.default));
export const PickerMenu = lazyPart(() => import("./PickerMenu").then((module) => module.default));
export const MessageEditor = lazyPart(() => import("./MessageEditor").then((module) => module.MessageEditor));

let loading: Promise<void> | null = null;

/** Fetches every part a chat loads apart, so a chat never draws without one it needs. */
export const loadChatParts = () =>
    (loading ??= loadParts([QuestionRows, LiveStack, ChatFailureActions, ComposerMenu, DictationPreview, PickerMenu, MessageEditor]));
