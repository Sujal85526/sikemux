import type { AcpAvailableCommand } from '@mac/chat/types';

/** The agent's slash commands with what is typed anywhere in their name, while only a command is typed, as on the Mac. */
export function matchingCommands(commands: AcpAvailableCommand[], typed: string): AcpAvailableCommand[] {
  const needle = /^\/(\S*)$/.exec(typed)?.[1]?.toLowerCase();
  if (needle === undefined) return [];
  return commands.filter((command) => command.name.toLowerCase().includes(needle)).slice(0, 8);
}
