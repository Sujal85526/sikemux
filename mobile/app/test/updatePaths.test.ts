import { describe, expect, it } from 'vitest';

import { bundleInputs, matchesFilter, updateWorkflowPaths } from '../scripts/bundle-inputs.mjs';

describe('the update workflow', () => {
  it('reads GitHub path filters the way Actions does', () => {
    expect(matchesFilter('mobile/app/src/chat/useChat.ts', 'mobile/app/src/**')).toBe(true);
    expect(matchesFilter('mobile/app/modules/notify/index.ts', 'mobile/app/modules/*/index.ts')).toBe(true);
    expect(matchesFilter('mobile/app/modules/notify/android/Keys.kt', 'mobile/app/modules/*/index.ts')).toBe(false);
    expect(matchesFilter('src/lib/paths.ts', 'src/lib/paths.ts')).toBe(true);
    expect(matchesFilter('src/lib/pathsXts', 'src/lib/paths.ts')).toBe(false);
  });

  it('runs on a change to any file the phone bundle is built from', async () => {
    const filters = updateWorkflowPaths();
    expect(filters.length).toBeGreaterThan(5);
    const missed = (await bundleInputs()).filter((path: string) => !filters.some((filter: string) => matchesFilter(path, filter)));
    expect(missed).toEqual([]);
  });
});
