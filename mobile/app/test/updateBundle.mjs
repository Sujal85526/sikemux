import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ASSET_URL = 'https://updates.sikemux.com/assets/';

/**
 * Writes an update the way `publish-update.mjs prepare` does; `change` may alter it before it is saved.
 * @param {(parts: any) => void} [change]
 */
export function writeUpdate(change = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sikemux-update-test-'));
  mkdirSync(join(dir, 'assets'));
  const bytes = 'globalThis.app = 1;';
  const hex = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(dir, 'assets', hex), bytes);
  writeFileSync(join(dir, 'assets', `${hex}.type`), 'application/javascript\n');
  const update = {
    id: randomUUID(),
    createdAt: '2026-10-06T10:00:00.000Z',
    platform: 'android',
    runtimeVersion: 'abc',
    channel: 'nightly',
  };
  const manifest = {
    id: update.id,
    createdAt: update.createdAt,
    runtimeVersion: update.runtimeVersion,
    launchAsset: {
      hash: createHash('sha256').update(bytes).digest('base64url'),
      key: 'k',
      contentType: 'application/javascript',
      fileExtension: '.bundle',
      url: `${ASSET_URL}${hex}`,
    },
    assets: [],
  };
  change({ manifest, write: (name, contents) => writeFileSync(join(dir, name), contents) });
  writeFileSync(join(dir, 'update.json'), JSON.stringify(update));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
