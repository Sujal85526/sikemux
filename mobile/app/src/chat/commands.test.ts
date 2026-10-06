import { describe, expect, it } from 'vitest';

import { matchingCommands } from './commands';

const commands = ['compact', 'context', 'cost', 'clear', 'review', 'pr-comments', 'init', 'memory', 'model', 'agents'].map((name) => ({
  name,
  description: '',
}));

describe('slash commands', () => {
  it('match what is typed anywhere in their name, eight at most', () => {
    expect(matchingCommands(commands, '/co').map((command) => command.name)).toEqual(['compact', 'context', 'cost', 'pr-comments']);
    expect(matchingCommands(commands, '/').length).toBe(8);
    expect(matchingCommands(commands, '/CO').length).toBe(4);
  });

  it('are offered only while a command alone is typed', () => {
    expect(matchingCommands(commands, '/co now')).toEqual([]);
    expect(matchingCommands(commands, 'co')).toEqual([]);
  });
});
