import type { ConnectionLike } from '@sikemux/native';

/** The parts of the core's protocol (`sikemux_core::protocol`) the phone reads. */

export type SessionInfo = {
  id: number;
  kind: 'terminal' | 'task';
  running: boolean;
  project: string | null;
  agentType: string | null;
  agentState: string | null;
  startedBy: string | null;
  task: { label: string; command: string; cwd: string } | null;
  exit: { code: number | null; signal: string | null } | null;
};

export type ChatInfo = {
  agentId: string;
  provider: string;
  title: string | null;
  cwd: string;
  state: 'starting' | 'ready';
  running: boolean;
  pendingPermissions: string[];
  permissionMode: string;
  model: string | null;
  asleep: boolean;
};

export type Attention = {
  id: string;
  kind: 'permission';
  agentId: string;
  provider: string;
  cwd: string;
  at: number;
};

export type ProjectInfo = { id: string; name: string; path: string };

export type LauncherInfo = { id: string; provider: string; label: string; permissionMode: string };

export type Workspace = { projects: ProjectInfo[]; launchers: LauncherInfo[] };

export type BuildChannel = 'dev' | 'nightly' | 'stable';
export type HostInfo = { name: string; model: string; version: string; channel: BuildChannel };

type Response =
  | { kind: 'sessions'; sessions: SessionInfo[] }
  | { kind: 'chats'; chats: ChatInfo[] }
  | { kind: 'attentions'; attentions: Attention[] }
  | { kind: 'workspace'; workspace: Workspace }
  | { kind: 'host'; host: HostInfo };

type Answer<K extends Response['kind']> = Extract<Response, { kind: K }>;

async function ask<K extends Response['kind']>(
  connection: ConnectionLike,
  op: string,
  kind: K,
): Promise<Answer<K>> {
  const response = JSON.parse(await connection.request(JSON.stringify({ op }))) as Response;
  if (response.kind !== kind) throw new Error(`the Mac answered ${op} with ${response.kind}`);
  return response as Answer<K>;
}

export type Snapshot = {
  workspace: Workspace;
  sessions: SessionInfo[];
  chats: ChatInfo[];
  attentions: Attention[];
};

export async function snapshot(connection: ConnectionLike): Promise<Snapshot> {
  const [workspace, sessions, chats, attentions] = await Promise.all([
    ask(connection, 'workspace', 'workspace'),
    ask(connection, 'list', 'sessions'),
    ask(connection, 'acpList', 'chats'),
    ask(connection, 'attentions', 'attentions'),
  ]);
  return {
    workspace: workspace.workspace,
    sessions: sessions.sessions,
    chats: chats.chats,
    attentions: attentions.attentions,
  };
}

export async function host(connection: ConnectionLike): Promise<HostInfo> {
  return (await ask(connection, 'host', 'host')).host;
}
