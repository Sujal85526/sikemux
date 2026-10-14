import { useEffect, useState } from 'react';
import type { ConnectionLike } from '@sikemux/native';

type AgentName = { agentId: string; name: string; project: string; parent?: string | null };

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * The agent that started each agent running on the host, read with its `agentNames` call whenever `agents` changes.
 * A host from before that call has none.
 */
export function useLeads(connection: ConnectionLike | undefined, agents: string): ReadonlyMap<string, string> {
  const [leads, setLeads] = useState(NONE);
  useEffect(() => {
    if (!connection || !agents) return;
    let current = true;
    connection.call('agentNames', 'null').then(
      (text) => {
        const named = JSON.parse(text) as AgentName[];
        if (current) setLeads(new Map(named.flatMap((agent) => (agent.parent ? [[agent.agentId, agent.parent] as const] : []))));
      },
      () => {
        if (current) setLeads(NONE);
      },
    );
    return () => {
      current = false;
    };
  }, [connection, agents]);
  return leads;
}
