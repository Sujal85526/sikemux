const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

// The runtime version is this fingerprint: an over-the-air update only reaches builds with the native code
// it was made for. The Rust client is native code too, so its sources count, with every crate the phone links.
const RUST = [
  '../../rust-toolchain.toml',
  '../../src-tauri/Cargo.toml',
  '../../src-tauri/Cargo.lock',
  '../../src-tauri/crates/sikemux-mobile',
  '../../src-tauri/crates/sikemux-core',
  '../../src-tauri/crates/sikemux-process',
  '../../src-tauri/crates/sikemux-pty',
];

// mobile/native is generated from the Rust sources above, differently on each machine, and is only linked once
// it has been built, so the fingerprint counts its own few files instead and drops it from the linked modules.
const NATIVE = join(__dirname, '../native');
const NATIVE_FILES = [
  'package.json',
  'ubrn.config.yaml',
  ...readdirSync(join(NATIVE, 'scripts'))
    .sort()
    .map((name) => `scripts/${name}`),
];
const LINKED_MODULES = ['rncoreAutolinkingConfig:android', 'rncoreAutolinkingConfig:ios'];

/** @type {import('expo/fingerprint').Config} */
module.exports = {
  sourceSkips: ['ExpoConfigVersions', 'PackageJsonAndroidAndIosScriptsIfNotContainRun'],
  extraSources: [
    ...RUST.map((filePath) => ({
      type: filePath.endsWith('.toml') || filePath.endsWith('.lock') ? 'file' : 'dir',
      filePath,
      reasons: ['rustClient'],
    })),
    ...NATIVE_FILES.map((name) => ({
      type: 'contents',
      id: `native/${name}`,
      contents: readFileSync(join(NATIVE, name)),
      reasons: ['rustClient'],
    })),
  ],
  ignorePaths: ['**/target/**/*', '../native/**/*'],
  fileHookTransform(source, chunk) {
    if (source.type !== 'contents' || chunk == null) return chunk;
    // Nightly and stable builds of the same code share a runtime version, so an update promoted to stable still fits.
    if (source.id === 'expoConfig') {
      const config = JSON.parse(chunk.toString());
      delete config.updates?.requestHeaders;
      return JSON.stringify(config);
    }
    if (LINKED_MODULES.includes(source.id)) {
      const modules = JSON.parse(chunk.toString());
      delete modules['@sikemux/native'];
      return JSON.stringify(modules);
    }
    return chunk;
  },
};
