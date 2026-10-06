import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ios = fileURLToPath(new URL('../modules/notify/ios/', import.meta.url));
const vector = fileURLToPath(new URL('../../../server/protocol/vectors/push.json', import.meta.url));

export const swiftAvailable = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;

/** Builds the extension's decryptor with modules/notify/ios/Tests/main.swift and runs it on the core's vector. */
export function openVectorInSwift() {
  const dir = mkdtempSync(join(tmpdir(), 'sikemux-notify-'));
  try {
    const shared = readdirSync(join(ios, 'Shared')).map((name) => join(ios, 'Shared', name));
    const binary = join(dir, 'check');
    execFileSync('xcrun', ['swiftc', '-o', binary, ...shared, join(ios, 'Tests', 'main.swift')], { stdio: 'pipe' });
    return execFileSync(binary, [vector], { encoding: 'utf8' }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
