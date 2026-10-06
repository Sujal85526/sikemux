import { describe, expect, it } from 'vitest';

import { check, reaches, Refused, releasedRuntimes } from '../scripts/publish-update.mjs';
import { ASSET_URL, writeUpdate } from './updateBundle.mjs';

type Parts = { manifest: { runtimeVersion: string; launchAsset: { url: string } }; write(name: string, contents: string): void };

describe('check', () => {
  it('takes a whole update and counts what it carries', () => {
    expect(check(writeUpdate())).toMatchObject({ assets: 1, bytes: 19 });
  });

  it('refuses an asset whose bytes are not what the manifest hashed', () => {
    const dir = writeUpdate(({ manifest, write }: Parts) =>
      write(`assets/${manifest.launchAsset.url.slice(ASSET_URL.length)}`, 'tampered'),
    );
    expect(() => check(dir)).toThrow(Refused);
  });

  it('refuses a file the manifest does not name', () => {
    const dir = writeUpdate(({ write }: Parts) => write(`assets/${'f'.repeat(64)}`, 'extra'));
    expect(() => check(dir)).toThrow(/is not named by the manifest/);
  });

  it('refuses a manifest that disagrees with update.json', () => {
    const dir = writeUpdate(({ manifest }: Parts) => {
      manifest.runtimeVersion = 'other';
    });
    expect(() => check(dir)).toThrow(/disagree on runtimeVersion/);
  });
});

describe('which builds an update reaches', () => {
  it('publishes only when a released build has the runtime, and says when no release tells', () => {
    expect(reaches('abc', ['abc', 'def'])).toBe('some');
    expect(reaches('abc', ['def'])).toBe('none');
    expect(reaches('abc', [])).toBe('unknown');
    expect(reaches('abc', null)).toBe('unknown');
  });

  it("reads each phone release's runtime, skipping the Mac's releases and phone releases without one", () => {
    const asked: string[][] = [];
    const gh = (args: string[]) => {
      asked.push(args);
      if (args[1] === 'list')
        return JSON.stringify([{ tagName: 'v0.5.0' }, { tagName: 'mobile-v0.1.0-nightly.6' }, { tagName: 'mobile-v0.1.0-nightly.5' }]);
      if (args[2] === 'mobile-v0.1.0-nightly.6') return 'abc\n';
      throw new Error('no asset');
    };
    expect(releasedRuntimes('android', gh)).toEqual(['abc']);
    expect(asked.filter((args) => args[1] === 'download').map((args) => args[2])).toEqual([
      'mobile-v0.1.0-nightly.6',
      'mobile-v0.1.0-nightly.5',
    ]);
    expect(asked[1]).toContain('runtime-android.txt');
  });

  it("can't tell when GitHub can't be asked", () => {
    expect(
      releasedRuntimes('android', () => {
        throw new Error('gh: not logged in');
      }),
    ).toBeNull();
  });
});
