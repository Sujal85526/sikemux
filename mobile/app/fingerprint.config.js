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

/** @type {import('expo/fingerprint').Config} */
module.exports = {
  sourceSkips: ['ExpoConfigVersions', 'PackageJsonAndroidAndIosScriptsIfNotContainRun'],
  extraSources: RUST.map((filePath) => ({
    type: filePath.endsWith('.toml') || filePath.endsWith('.lock') ? 'file' : 'dir',
    filePath,
    reasons: ['rustClient'],
  })),
  // The bindings and libraries in mobile/native are built from the Rust sources above, differently on each machine.
  ignorePaths: [
    '**/target/**/*',
    '**/native/{android,ios,cpp,src,build,node_modules}/**/*',
    '**/native/*.podspec',
    '**/native/*.xcframework/**/*',
  ],
  // Nightly and stable builds of the same code share a runtime version, so an update promoted to stable still fits.
  fileHookTransform(source, chunk) {
    if (source.type !== 'contents' || source.id !== 'expoConfig' || chunk == null) return chunk;
    const config = JSON.parse(chunk.toString());
    delete config.updates?.requestHeaders;
    return JSON.stringify(config);
  },
};
