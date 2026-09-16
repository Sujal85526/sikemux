export interface AcpContentBlock {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    name?: string;
    title?: string;
    uri?: string;
    resource?: unknown;
    [key: string]: unknown;
}

export interface AcpContentChunk {
    content: AcpContentBlock;
    messageId?: string;
}

export interface AcpAvailableCommand {
    name: string;
    description: string;
    input?: { hint?: string };
}

export interface AcpPermissionOption {
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpPermissionRequest {
    requestId: string;
    sessionId: string;
    toolCall: AcpToolCall;
    options: AcpPermissionOption[];
}

export interface AcpToolCall {
    toolCallId: string;
    title: string;
    kind?: string;
    status?: string;
    content?: unknown[];
    locations?: unknown[];
    rawInput?: unknown;
    rawOutput?: unknown;
    [key: string]: unknown;
}

export interface AcpAsyncTask {
    asyncTaskId: string;
    name: string;
    taskType: string;
    description: string;
    state: "running" | "paused" | "completed" | "failed" | "stopped";
    canStop: boolean;
    summary?: string;
    lastToolName?: string;
    outputFilePath?: string;
    usage?: { totalTokens: number; toolUses: number; durationMs: number };
}

/* A subagent runs as its own ACP session, so its transcript is kept whole
   rather than spliced into the parent's. */
export interface AcpSubagent {
    sessionId: string;
    name: string;
    task: string;
    state: "running" | "completed" | "failed" | "cancelled" | "disconnected";
    messages: ChatMessage[];
    nextId: number;
}

/* What a background task left behind once it ended, kept in the transcript
   because the live task above the composer goes away with it. */
export interface AcpTaskNotice {
    name: string;
    state: "completed" | "failed" | "stopped";
    summary?: string;
}

export type ChatPart =
    | { id: string; kind: "text"; text: string }
    | { id: string; kind: "thought"; text: string }
    | { id: string; kind: "content"; content: AcpContentBlock }
    | { id: string; kind: "tool"; tool: AcpToolCall }
    | { id: string; kind: "subagent"; subagent: AcpSubagent }
    | { id: string; kind: "notice"; notice: AcpTaskNotice };

export interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    parts: ChatPart[];
    attachments?: string[];
}

export interface ChatState {
    connection: "connecting" | "installing" | "starting" | "initializing" | "ready" | "stopped" | "error";
    messages: ChatMessage[];
    commands: AcpAvailableCommand[];
    permissions: AcpPermissionRequest[];
    tasks: AcpAsyncTask[];
    capabilities: Record<string, unknown>;
    setup: Record<string, unknown>;
    plan: unknown;
    usage: unknown;
    running: boolean;
    suppressUserEcho: boolean;
    error: string | null;
    title: string | null;
    stopReason: string | null;
    nextId: number;
    revision: number;
}

export type ChatAction =
    | { type: "reset" }
    | { type: "config"; options: unknown }
    | { type: "status"; state: ChatState["connection"] }
    | { type: "ready"; capabilities: Record<string, unknown>; setup: Record<string, unknown> }
    | { type: "local_prompt"; text: string; paths: string[] }
    | { type: "session_update"; sessionId: string; update: Record<string, unknown> }
    | { type: "turn_started" }
    | { type: "turn_completed"; stopReason?: string }
    | { type: "permission_requested"; request: AcpPermissionRequest }
    | { type: "permission_cleared"; requestId: string }
    | { type: "error"; message: string };
